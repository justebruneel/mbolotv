import { parseXmltvStream } from './xmltv.parser';

function toStream(xml: string): ReadableStream<Uint8Array> {
  const bytes = Buffer.from(xml);
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(index, index + 64));
      index += 64;
    },
  });
}

describe('parseXmltvStream', () => {
  it('extrait les chaînes et programmes, décodes les entités, découpe les lots', async () => {
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

    const seen: string[] = [];
    const result = await parseXmltvStream(toStream(xml), async (batch) => {
      for (const programme of batch) {
        seen.push(
          `${programme.channelId}|${programme.title}|${programme.description ?? ''}|${programme.categories.join('/')}|${programme.startsAt.toISOString()}`,
        );
      }
      return batch.length;
    });

    expect(result.channels).toBe(2);
    expect(result.programmes).toBe(2);
    expect(result.stored).toBe(2);
    expect(seen).toEqual([
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
    const result = await parseXmltvStream(toStream(xml), async () => {
      seen += 1;
      return 1;
    });

    expect(seen).toBe(0);
    expect(result.programmes).toBe(2);
  });
});
