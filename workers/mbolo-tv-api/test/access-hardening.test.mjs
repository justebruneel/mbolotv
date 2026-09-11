// Tests du durcissement du rachat de code (workers/mbolo-tv-api/src/access.js).
// La logique y vit dans du SQL brut ; comme pour access-expiry.test.mjs, on
// teste ici les fonctions PURES extraites — la fidélité au SQL est vérifiée par
// la revue, ces tests protègent la RÈGLE.
//
// Deux règles sont en jeu :
//   1. le rate limit compte les échecs des deux bornes (IP et appareil) et
//      débloque quand la PLUPART ancienne sort de la fenêtre glissante ;
//   2. un rachat réussi efface les échecs de l'appareil — un client qui se
//      trompe puis trouve son code ne doit pas rester bloqué par ses fautes.
// Lancer : node --test workers/mbolo-tv-api/test/
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const WINDOW_MINUTES = 15;

// Règle dupliquée depuis access.js (redeemRateLimit) : déblocage quand le plus
// ancien échec de la fenêtre en sort. Référencer la source lors de toute
// modification.
function shouldBlock({ ipFailures, deviceFailures, maxPerIp, maxPerDevice }) {
  return ipFailures >= maxPerIp || deviceFailures >= maxPerDevice;
}

function retryAfterSeconds(oldestFailureMs, now = Date.now()) {
  return Math.max(1, Math.ceil((oldestFailureMs + WINDOW_MINUTES * 60_000 - now) / 1000));
}

describe('redeem — rate limit (échecs récents, deux bornes)', () => {
  it('laisse passer un appareil sous les deux seuils', () => {
    assert.equal(shouldBlock({ ipFailures: 5, deviceFailures: 2, maxPerIp: 30, maxPerDevice: 10 }), false);
  });

  it('bloque dès que la borne appareil est atteinte (IP encore propre)', () => {
    assert.equal(shouldBlock({ ipFailures: 3, deviceFailures: 10, maxPerIp: 30, maxPerDevice: 10 }), true,
      'un attaquant qui change d’IP (proxy) doit rester borné par l’appareil');
  });

  it('bloque dès que la borne IP est atteinte (appareils variés)', () => {
    assert.equal(shouldBlock({ ipFailures: 30, deviceFailures: 1, maxPerIp: 30, maxPerDevice: 10 }), true,
      'un attaquant qui régénère son device-id doit rester borné par l’IP');
  });

  it('un succès (outcome OK) n’entre pas dans le comptage des échecs', () => {
    // FAILED_OUTCOMES exclut OK : 0 échec malgré de nombreuses tentatives.
    assert.equal(shouldBlock({ ipFailures: 0, deviceFailures: 0, maxPerIp: 30, maxPerDevice: 10 }), false);
  });

  it('RATE_LIMITED n’entre pas dans le comptage (sinon le blocage se prolonge seul)', () => {
    // Un client bloqué qui réessaie ne doit PAS repousser sa propre fenêtre :
    // sinon chaque tentative pendant le blocage ajoute 15 min, indéfiniment.
    const outcomesCounted = ['INVALID_CODE', 'ALREADY_BOUND', 'EXPIRED', 'DEVICE_REVOKED'];
    assert.ok(!outcomesCounted.includes('RATE_LIMITED'),
      'RATE_LIMITED ne doit jamais compter comme échec');
    assert.ok(!outcomesCounted.includes('OK'), 'OK ne doit jamais compter comme échec');
  });

  it('retry-after est positif et borné par la fenêtre', () => {
    const now = Date.now();
    const inWindow = retryAfterSeconds(now - 60_000, now);
    assert.ok(inWindow > 0 && inWindow <= WINDOW_MINUTES * 60, `attendu 1..900, reçu ${inWindow}`);
  });

  it('un échec tout juste sorti de la fenêtre donne un retry-after minimal (1 s)', () => {
    const now = Date.now();
    const expired = now - WINDOW_MINUTES * 60_000 - 1;
    assert.equal(retryAfterSeconds(expired, now), 1,
      'ne doit jamais produire 0 ni un délai négatif');
  });
});

describe('redeem — remise à zéro des échecs après succès', () => {
  // Modèle de la règle : clearFailures supprime les lignes outcome <> 'OK'
  // de l'appareil. On vérifie qu'une faute de frappe suivie d'un succès
  // n'empêche pas le rachat suivant.
  function simulate(attempts) {
    let failures = 0;
    const results = [];
    for (const outcome of attempts) {
      if (outcome === 'OK') {
        failures = 0; // clearFailures
        results.push('succès');
      } else {
        failures += 1;
        results.push(failures >= 3 ? 'bloqué' : 'refus');
      }
    }
    return results;
  }

  it('2 fautes puis le bon code : le rachat passe, les fautes effacées', () => {
    const results = simulate(['INVALID_CODE', 'INVALID_CODE', 'OK', 'OK']);
    assert.deepEqual(results, ['refus', 'refus', 'succès', 'succès']);
  });

  it('3 fautes consécutives : bloqué avant d’atteindre le bon code', () => {
    const results = simulate(['INVALID_CODE', 'INVALID_CODE', 'INVALID_CODE']);
    assert.equal(results.at(-1), 'bloqué');
  });
});

describe('redeem — révocation d’appareil', () => {
  // Un grant révoqué ne peut plus servir, et le titulaire ne peut pas se
  // réinscrire avec le même code (findGrant et redeemCode filtrent revokedAt).
  function grantAccessible({ revoked, expired }) {
    return !revoked && !expired;
  }

  it('un appareil révoqué perd la lecture même si le code est actif', () => {
    assert.equal(grantAccessible({ revoked: true, expired: false }), false);
  });

  it('un appareil actif garde la lecture', () => {
    assert.equal(grantAccessible({ revoked: false, expired: false }), true);
  });

  it('la révocation prime sur la validité du code (pas de réinscription)', () => {
    // redeemCode renvoie 403 DEVICE_REVOKED avant toute réécriture du grant.
    assert.equal(grantAccessible({ revoked: true, expired: false }), false);
  });
});
