import { Readable } from 'node:stream';
import { parseM3uStreamBatched } from './m3u.parser';

describe('parseM3uStreamBatched', () => {
  it('émet des lots dans l’ordre sans attendre un fichier entier', async () => {
    const batches: string[][] = [];
    const content = ['#EXTM3U', '#EXTINF:-1,tvg-name="One",One', 'https://example.com/one.ts', '#EXTINF:-1,tvg-name="Two",Two', 'https://example.com/two.ts', '#EXTINF:-1,tvg-name="Three",Three', 'https://example.com/three.ts'].join('\n');
    const total = await parseM3uStreamBatched(Readable.from([content]), { batchSize: 2, onBatch: (batch) => batches.push(batch.map((entry) => entry.title)) });
    expect(total).toBe(3);
    expect(batches).toEqual([['One', 'Two'], ['Three']]);
  });

  it('refuse une playlist qui dépasse la limite d’octets', async () => {
    await expect(parseM3uStreamBatched(Readable.from(['#EXTM3U\n', 'x'.repeat(100)]), { maxBytes: 16, onBatch: () => undefined })).rejects.toThrow('Contenu trop volumineux');
  });
});
