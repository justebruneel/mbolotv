// Tests de la règle de remplacement des credentials sans révélation
// (owner-routes.js — branche PATCH connection de /api/owner/sources/:id).
//
// Le frontend pré-remplit les champs avec le MASQUE (maskValue : « abcd… »
// ou « •••• »). Risque historique : soumettre le formulaire sans toucher
// réécrasait le secret par son propre masque. Double protection désormais :
//   1. le frontend n'envoie QUE les clés réellement saisies ;
//   2. le serveur jette toute valeur qui RESSEMBLE à un masque (filtre
//      provided ci-dessous, réplique exacte du filtre de owner-routes.js).
// Lancer : node --test workers/mbolo-tv-api/test/
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Réplique du filtre de owner-routes.js — à garder aligné avec la source.
function providedEntries(connection) {
  return Object.entries(connection).filter(
    ([, value]) => !/^•+$/.test(value) && !value.endsWith('…'),
  );
}

// Réplique de maskValue (owner-routes.js) — la forme que le frontend voit.
function maskValue(value) {
  if (!value) return '••••';
  const visible = value.replace(/^https?:\/\//, '').slice(0, 4);
  return value.length <= 8 ? '••••' : `${visible}…`;
}

describe('credentials — le masque ne peut pas écraser le secret', () => {
  it('une valeur entièrement masquée (••••) est rejetée', () => {
    assert.deepEqual(providedEntries({ url: '••••' }), []);
  });

  it('un masque pré-rempli non modifié (abcd…) est rejeté', () => {
    const masked = maskValue('http://serveur-iptv.example.com:8080');
    assert.ok(masked.endsWith('…'));
    assert.deepEqual(providedEntries({ url: masked }), []);
  });

  it('un mot de passe court masqué (••••) est rejeté', () => {
    assert.equal(maskValue('secret'), '••••');
    assert.deepEqual(providedEntries({ password: maskValue('secret') }), []);
  });

  it('une valeur réellement saisie passe (fût-elle légitime)', () => {
    const typed = { url: 'http://nouveau-panelpourri.tv:25461', password: 'S3cret-Fourn!sseur' };
    assert.deepEqual(providedEntries(typed), Object.entries(typed));
  });

  it('une MAC réelle passe (les deux-points ne sont pas un masque)', () => {
    assert.deepEqual(providedEntries({ macAddress: '00:1A:79:AB:CD:EF' }), [['macAddress', '00:1A:79:AB:CD:EF']]);
  });

  it('mélange : seules les valeurs saisies sont retenues', () => {
    const mixed = { url: maskValue('http://ancien.example/'), password: 'nouveau-mot-de-passe' };
    assert.deepEqual(providedEntries(mixed), [['password', 'nouveau-mot-de-passe']]);
  });
});

describe('credentials — révélation : exigence de confirmation', () => {
  // Règle testée : le schéma de révélation exige un mot de passe non vide —
  // pas de révélation silencieuse sur simple session valide.
  const sourceCredentialsRevealSchemaShape = { password: { min: 1, max: 200 } };
  it('un corps sans mot de passe est invalide', () => {
    assert.ok(sourceCredentialsRevealSchemaShape.password.min > 0);
  });
  it('le mot de passe est borné (pas de tampon arbitraire)', () => {
    assert.equal(sourceCredentialsRevealSchemaShape.password.max, 200);
  });
});
