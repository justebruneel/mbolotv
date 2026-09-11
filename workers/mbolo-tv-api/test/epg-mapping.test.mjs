// Port de epg-import.spec.ts (apps/api, gelée — ADR-0002 Phase 3). La
// référence testait partitionByTvgId/resolveByName (helpers Prisma) ; le
// Worker mappe en flux via channelKey (tolérance accents/casse/qualité/pays)
// — la logique équivalente vit dans epgimport.js. On porte les CAS de
// référence sur channelKey et on ajoute les cas de tolérance propres au
// Worker (qui font la vraie différence en prod sur les playlists réelles).
// Lancer : node --test workers/mbolo-tv-api/test/
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { channelKey } from '../src/epgimport.js';

describe('channelKey — mapping EPG porté de apps/api', () => {
  it('insensible à la casse (tvg-id "TF1.sd" vs "tf1.sd" même clé)', () => {
    assert.equal(channelKey('TF1.sd'), channelKey('tf1.sd'));
  });

  it('insensible aux accents (Canal+ Cinéma vs canal+ cinema)', () => {
    assert.equal(channelKey('Canal+ Cinéma'), channelKey('canal+ cinema'));
  });

  it('note de parité : le "+" est avalé ("Canal+" = "canal") — comportement Worker distinct de la référence Prisma', () => {
    // La référence comparait les chaînes brutes ; le Worker normalise fort :
    // "Canal+" et "Canal" deviennent identiques. Documenté ici comme choix
    // assumé (le mapping réel passe d'abord par le tvg-id brut de toute façon).
    assert.equal(channelKey('Canal+'), 'canal');
    assert.equal(channelKey('Canal'), 'canal');
  });

  it('ignore la ponctuation et les séparateurs', () => {
    assert.equal(channelKey('france-3'), channelKey('France 3'));
    assert.equal(channelKey('bein.sports.1'), channelKey('bein sports 1'));
  });

  it('ignore les suffixes qualité (HD/FHD/4K/UHD/SD)', () => {
    assert.equal(channelKey('TF1 HD'), channelKey('TF1'));
    assert.equal(channelKey('TF1 FHD'), channelKey('TF1'));
    assert.equal(channelKey('TF1 4K UHD'), channelKey('TF1'));
  });

  it('ignore les préfixes pays ("fr: TF1" = "TF1")', () => {
    assert.equal(channelKey('fr: TF1'), channelKey('TF1'));
    assert.equal(channelKey('us|HBO'), channelKey('HBO'));
  });

  it('ignore les tags entre crochets et drapeaux emoji', () => {
    assert.equal(channelKey('TF1 [FR]'), channelKey('TF1'));
    assert.equal(channelKey('🇫🇷 TF1'), channelKey('TF1'));
  });

  it('deux chaînes différentes gardent des clés distinctes', () => {
    assert.notEqual(channelKey('TF1'), channelKey('TF2'));
    assert.notEqual(channelKey('Canal+'), channelKey('Canal+ Sport'));
  });
});
