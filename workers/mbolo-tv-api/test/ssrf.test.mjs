// Port des tests SSRF de la référence (ssrf.spec.ts + safe-fetcher — apps/api
// gelée, ADR-0002 Phase 3) vers la garde Worker isPrivateHostname (relay.js).
// Différences assumées et documentées :
//   - le Nest faisait une résolution DNS réelle (assertSafeUrl) ; le Worker
//     juge le hostname littéralement (les imports partent de l'URL de source
//     configurée par l'owner, pas d'une URL utilisateur) ;
//   - isPrivateHostname est volontairement LISIBLE plutôt qu'exhaustive :
//     CGNAT 100.64/10, link-local 169.254, loopbacks, RFC1918, hosts sans
//     point — les blocs benchmark/documentation (::, 2001:db8, 198.18/15) ne
//     sont pas listés (surface : config owner-only, cf. ADR-0002).
// Lancer : node --test workers/mbolo-tv-api/test/
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateHostname } from '../src/relay.js';

describe('isPrivateHostname (SSRF) — porté de apps/api', () => {
  it('rejette les IP privées littérales (boucle, link-local AWS métadonnées, RFC1918)', () => {
    assert.equal(isPrivateHostname('127.0.0.1'), true);
    assert.equal(isPrivateHostname('169.254.169.254'), true, 'endpoint métadonnées cloud');
    assert.equal(isPrivateHostname('10.0.0.1'), true);
    assert.equal(isPrivateHostname('192.168.1.1'), true);
    assert.equal(isPrivateHostname('172.16.0.1'), true);
    assert.equal(isPrivateHostname('172.31.255.255'), true);
    assert.equal(isPrivateHostname('100.64.0.1'), true, 'CGNAT (Tailscale, CGNAT FAI)');
  });

  it('rejette localhost et les hosts sans point', () => {
    assert.equal(isPrivateHostname('localhost'), true);
    assert.equal(isPrivateHostname('api'), true, 'nom nu = réseau interne');
    assert.equal(isPrivateHostname('monserveur.local'), true);
  });

  it('rejette les IPv6 privées', () => {
    assert.equal(isPrivateHostname('::1'), true);
    assert.equal(isPrivateHostname('fc00::1'), true, 'ULA fd/fc');
    assert.equal(isPrivateHostname('fd12:3456::1'), true);
    assert.equal(isPrivateHostname('fe80::1'), true, 'link-local');
  });

  it('accepte une IP publique et un hostname public', () => {
    assert.equal(isPrivateHostname('example.com'), false);
    assert.equal(isPrivateHostname('5.63.50.1'), false);
    assert.equal(isPrivateHostname('172.32.0.1'), false, 'juste au-dessus du bloc RFC1918');
  });
});
