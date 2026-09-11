// Tests du pepper HMAC des codes d'accès (workers/mbolo-tv-api/src/access.js
// — lookupAccessCode — et owner-routes.js — création).
//
// La règle protégée : l'empreinte stockée est HMAC-SHA256(pepper, code) quand
// ACCESS_CODE_PEPPER est défini, avec repli sha256(code) nu. La lecture accepte
// les DEUX variantes (migration à la volée), l'écriture n'écrit QUE la variante
// pepperée. Un dump de la base sans le pepper ne doit pas permettre de
// retrouver les codes hors ligne.
//
// Ces tests tournent le code RÉEL des modules (WebCrypto est disponible dans
// Node ≥ 20) — contrairement aux tests de règles pures du même dossier.
// Lancer : node --test workers/mbolo-tv-api/test/
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sha256Hex, hmacSha256Hex } from '../src/crypto.js';

const PEPPER = 'pepper-de-test-32-chars-minimum!';

// Réplique fidèle de lookupAccessCode (access.js) : la logique de sélection
// vit dans du SQL brut, non importable — référencer la source à toute
// modification de l'une ou l'autre.
async function resolveStoredHash(env, normalized) {
  const plainHash = await sha256Hex(normalized);
  const pepper = String(env.ACCESS_CODE_PEPPER ?? '').trim();
  const pepperHash = pepper ? await hmacSha256Hex(pepper, normalized) : null;
  const candidates = [pepperHash, plainHash].filter(Boolean);
  // La "base" est simulée : on renvoie la première empreinte candidate qui
  // existe — même sémantique que WHERE codeHash = ANY($1) LIMIT 1.
  return { candidates, plainHash, pepperHash };
}

describe('pepper — empreintes des codes', () => {
  it('HMAC(pepper, code) diffère de sha256(code) : le dump seul ne suffit pas', async () => {
    const code = 'MBLO-1A2B3C4D5E';
    const [plain, peppered] = await Promise.all([sha256Hex(code), hmacSha256Hex(PEPPER, code)]);
    assert.notEqual(plain, peppered);
    assert.equal(peppered.length, 64); // hex sha256
  });

  it('HMAC est déterministe et dépend du pepper', async () => {
    const code = 'PROMO-9F8E7D6C5B';
    const [a, b, other] = await Promise.all([
      hmacSha256Hex(PEPPER, code),
      hmacSha256Hex(PEPPER, code),
      hmacSha256Hex('autre-pepper', code),
    ]);
    assert.equal(a, b);
    assert.notEqual(a, other);
  });

  it('sans pepper, l’empreinte retombe sur sha256 nu (historique)', async () => {
    const code = 'MBLO-0000000000';
    const { candidates } = await resolveStoredHash({}, code);
    assert.deepEqual(candidates, [await sha256Hex(code)]);
  });

  it('avec pepper, la lecture porte les DEUX variantes (legacy + pepperée)', async () => {
    const code = 'MBLO-ABCDEF1234';
    const { candidates, plainHash, pepperHash } = await resolveStoredHash({ ACCESS_CODE_PEPPER: PEPPER }, code);
    assert.equal(candidates.length, 2);
    assert.deepEqual(candidates, [pepperHash, plainHash],
      'la pepperée d’abord : un code migré doit matcher sans lire la variante legacy');
  });

  it('normalisation : la casse et les espaces n’affectent pas l’empreinte', async () => {
    const normalize = (code) => code.trim().toUpperCase();
    const [a, b] = await Promise.all([
      hmacSha256Hex(PEPPER, normalize('  mblo-ab12cd34ef ')),
      hmacSha256Hex(PEPPER, normalize('MBLO-AB12CD34EF')),
    ]);
    assert.equal(a, b);
  });
});

describe('pepper — migration à la lecture', () => {
  // Réplique de la règle de réécriture : ne migrer que si l'empreinte trouvée
  // EST la variante legacy (sinon un UPDATE serait du bruit à chaque lecture).
  function shouldMigrate(foundHash, plainHash, pepperHash) {
    return Boolean(foundHash && pepperHash && foundHash === plainHash);
  }

  it('un code stocké en sha256 nu (legacy) doit migrer vers la pepperée', () => {
    assert.equal(shouldMigrate('legacy-hash', 'legacy-hash', 'peppered-hash'), true);
  });

  it('un code déjà pepperé ne déclenche pas de réécriture', () => {
    assert.equal(shouldMigrate('peppered-hash', 'legacy-hash', 'peppered-hash'), false);
  });

  it('sans pepper configuré, aucune migration (rien vers quoi migrer)', () => {
    assert.equal(shouldMigrate('legacy-hash', 'legacy-hash', null), false);
  });
});
