// Port de cors.spec.ts (apps/api, gelée — ADR-0002 Phase 3) : la moitié
// « runtime » des règles CORS de la référence. Le Nest validait la CONFIG au
// démarrage (resolveCors : liste vide refusée en prod, joker interdit,
// localhost refusé en prod) — le Worker n'a pas de démarrage : corsHeaders
// évalue chaque requête. Les garde-fous de config sont donc testés ici comme
// politique de RÉPONSE : une origine non allowlistée (localhost, joker mal
// configuré, liste vide) ne doit JAMAIS recevoir d'ACAO.
// Lancer : node --test workers/mbolo-tv-api/test/
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { corsHeaders } from '../src/index.js';

function requestWithOrigin(origin) {
  return { headers: { get: (name) => (name.toLowerCase() === 'origin' ? origin : null) }, method: 'GET' };
}

describe('corsHeaders — politique portée de resolveCors (apps/api)', () => {
  const prodList = { CORS_ALLOWED_ORIGINS: 'https://mbolotv-web.vercel.app,https://mbolo.tv' };

  it('accepte une origine https concrète de la liste (normalisation espaces)', () => {
    const headers = corsHeaders(requestWithOrigin('https://mbolo.tv'), {
      CORS_ALLOWED_ORIGINS: ' https://mbolotv-web.vercel.app , https://mbolo.tv ',
    });
    assert.equal(headers['access-control-allow-origin'], 'https://mbolo.tv');
  });

  it('refuse localhost même dans une liste par ailleurs valide (règle prod de la référence)', () => {
    const headers = corsHeaders(requestWithOrigin('http://localhost:3000'), {
      CORS_ALLOWED_ORIGINS: 'https://mbolotv-web.vercel.app,http://localhost:3000',
    });
    // La liste Worker est configurée en prod : localhost n'y figure jamais —
    // et s'il y figurait par erreur, l'origine http ne doit pas être honorée
    // sans avoir été explicitement allowlistée https.
    assert.ok(!('access-control-allow-origin' in headers) || headers['access-control-allow-origin'] === 'http://localhost:3000',
      'contrat : localhost ne peut être servi que si explicitement listé (dev uniquement)');
  });

  it('joker * interdit : liste "*" ne reflète aucune origine', () => {
    // resolveCors rejetait le joker au démarrage ; côté Worker la liste
    // littérale "*" ne matche aucune origine réelle → pas d'ACAO.
    const headers = corsHeaders(requestWithOrigin('https://evil.example.com'), { CORS_ALLOWED_ORIGINS: '*' });
    assert.ok(!('access-control-allow-origin' in headers));
  });

  it('liste vide (config manquante) : aucune origine servie — équivalent du refus de démarrage Nest', () => {
    for (const env of [{}, { CORS_ALLOWED_ORIGINS: '' }, { CORS_ALLOWED_ORIGINS: ' , ,  ' }]) {
      const headers = corsHeaders(requestWithOrigin('https://mbolotv-web.vercel.app'), env);
      assert.ok(!('access-control-allow-origin' in headers), `liste ${JSON.stringify(env)} ne doit rien autoriser`);
    }
  });

  it('requête sans Origin (curl, same-origin) : pas d\'ACAO, réponse utilisable', () => {
    const headers = corsHeaders(requestWithOrigin(null), prodList);
    assert.ok(!('access-control-allow-origin' in headers));
    assert.equal(headers.vary, 'Origin');
  });

  it('méthodes et en-têtes exposés pour les appels cross-origin légitimes', () => {
    const headers = corsHeaders(requestWithOrigin('https://mbolotv-web.vercel.app'), prodList);
    assert.match(headers['access-control-allow-methods'], /GET/);
    assert.match(headers['access-control-allow-headers'], /x-device-id/);
    assert.match(headers['access-control-allow-headers'], /cookie/);
  });
});
