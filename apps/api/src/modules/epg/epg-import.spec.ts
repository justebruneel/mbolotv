import { partitionByTvgId, resolveByName } from './epg-import.service';
import type { XmltvProgramme } from './xmltv.parser';

const aProgramme = (channel: string, title: string): XmltvProgramme => ({
  channelId: channel,
  startsAt: new Date('2026-09-08T10:00:00Z'),
  endsAt: new Date('2026-09-08T11:00:00Z'),
  title,
  description: `desc ${title}`,
  categories: ['Film'],
});
const buffered = (xmltvChannelId: string, title: string): Parameters<typeof resolveByName>[0][number] => ({
  xmltvChannelId,
  startsAt: new Date('2026-09-08T10:00:00Z'),
  endsAt: new Date('2026-09-08T11:00:00Z'),
  title,
  description: `desc ${title}`,
  categories: ['Film'],
});

describe('partitionByTvgId', () => {
  it('mappe par tvg-id (insensible à la casse) et bufferise les non-mappés', () => {
    const tvgMap = new Map([
      ['tf1.sd', 'ch-tf1'],
      ['canal+', 'ch-canal'],
    ]);
    const { matched, unmatched } = partitionByTvgId(
      [
        aProgramme('TF1.sd', 'JT'),
        aProgramme('CANAL+', 'Série'),
        aProgramme('inconnu.x', 'Film'),
      ],
      tvgMap,
    );
    expect(matched.map(({ channelId }) => channelId)).toEqual(['ch-tf1', 'ch-canal']);
    expect(unmatched.map((programme) => programme.xmltvChannelId)).toEqual(['inconnu.x']);
  });

  it('mappe par display-name à la fin (fallback) en écrivant toutes les lignes', () => {
    const fallback = [
      buffered('xx.1', 'Film A'),
      buffered('xx.1', 'Film B'),
      buffered('xx.2', 'Film C'),
    ];
    const { rows, matchedChannelIds } = resolveByName(
      fallback,
      { 'xx.1': 'TF1', 'xx.2': 'Aucune chaîne' },
      new Map([['tf1', 'ch-tf1']]),
    );
    // Les deux programmes de la chaîne fallback mappée sont écrits.
    expect(rows.map((row) => row.title)).toEqual(['Film A', 'Film B']);
    expect(rows.every((row) => row.channelId === 'ch-tf1')).toBe(true);
    expect([...matchedChannelIds]).toEqual(['ch-tf1']);
  });

  it('ignore les programmes irrésolus (ni tvg-id ni display-name connu)', () => {
    const { unmatched } = partitionByTvgId([aProgramme('zz', 'Film')], new Map());
    const { rows, matchedChannelIds } = resolveByName(unmatched, { zz: 'Boucle TV' }, new Map());
    expect(rows).toHaveLength(0);
    expect(matchedChannelIds.size).toBe(0);
  });
});