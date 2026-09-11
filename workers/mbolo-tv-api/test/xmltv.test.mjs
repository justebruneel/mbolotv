// Port de xmltv.parser.spec.ts (apps/api, gelée — ADR-0002 Phase 3) vers le
// parseur Worker src/xmltv.js. Différence d'API assumée : la référence
// découpe en lots (batch) et compte channels/programmes/stored ; le Worker
// pousse au fil de l'eau via onChannel/onProgramme — les compteurs sont
// reconstruits ici. Le mapping tvgId/display-name (epg-import.service) vit
// dans epgimport.js et est couvert indirectement par les imports réels.
// Lancer : node --test workers/mbolo-tv-api/test/
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseXmltvStream } from '../src/xmltv.js';

function toStream(xml) {
  const bytes = new TextEncoder().encode(xml);
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index >= bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.subarray(index, index + 64));
      index += 64;
    },
  });
}

describe('xmltv (worker) — porté de apps/api', () => {
  it('extrait les chaînes et programmes, décode les entités', async () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<tv generator-info-name="OTTO">
<channel id="skysportsf1.uk"><display-name>Sky F1 UK</display-name></channel>
<channel id="sport1.de"><display-name>Sport1</display-name></channel>
<programme start="20260813002800 +0000" stop="20260813011400 +0000" channel="skysportsf1.uk">
<title>Grand Prix &quot;Live&quot;</title>
<desc>Retransmission &amp; commentaires</desc>
<category>Formule 1</category>
</programme>
<programme start="20260813120000 +0100" stop="20260813130000 +0100" channel="sport1.de">
<title>Football</title>
</programme>
</tv>`;

    const seen = [];
    let channelCount = 0;
    const result = await parseXmltvStream(toStream(xml), {
      onChannel: () => { channelCount += 1; },
      onProgramme: (programme) => {
        seen.push(
          `${programme.channelId}|${programme.title}|${programme.description ?? ''}|${programme.categories.join('/')}|${programme.startsAt.toISOString()}`,
        );
      },
    });
    void result;

    assert.equal(channelCount, 2);
    assert.deepEqual(seen, [
      'skysportsf1.uk|Grand Prix "Live"|Retransmission & commentaires|Formule 1|2026-08-13T00:28:00.000Z',
      'sport1.de|Football|||2026-08-13T11:00:00.000Z',
    ]);
  });

  it('ignore les programmes incomplets (sans titre ou dates invalides)', async () => {
    const xml = `<tv>
<programme start="invalide" stop="20260813011400 +0000" channel="x">
<title>Privé de dates</title>
</programme>
<programme start="20260813002800 +0000" stop="20260813011400 +0000" channel="y">
<desc>Sans titre</desc>
</programme>
</tv>`;

    let seen = 0;
    await parseXmltvStream(toStream(xml), {
      onProgramme: () => { seen += 1; },
    });

    assert.equal(seen, 0);
  });

  it('gère les offsets négatifs et sans seconde', async () => {
    const xml = `<tv>
<programme start="20260813120000 -0500" stop="20260813130000 -0500" channel="z">
<title>Québec</title>
</programme>
</tv>`;
    const seen = [];
    await parseXmltvStream(toStream(xml), {
      onProgramme: (programme) => { seen.push(programme.startsAt.toISOString()); },
    });
    // 12:00 -05:00 → 17:00 UTC.
    assert.equal(seen[0], '2026-08-13T17:00:00.000Z');
  });
});
