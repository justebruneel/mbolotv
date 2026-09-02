import { ConfigService } from '@nestjs/config';
import { TvmazeProvider, stripHtml } from './tvmaze.provider';

function config(): ConfigService {
  return { get: (_key: string, fallback?: string) => fallback } as unknown as ConfigService;
}

function respond(shows: unknown[]): void {
  globalThis.fetch = jest.fn(async () => ({ ok: true, json: async () => shows })) as unknown as typeof fetch;
}

const show = (overrides: Record<string, unknown> = {}) => ({
  show: {
    id: 1,
    name: 'Kaamelott',
    genres: ['Comedy'],
    premiered: '2005-01-03',
    rating: { average: 8.4 },
    image: { medium: 'https://img/medium.jpg', original: 'https://img/original.jpg' },
    summary: '<p>Le roi <b>Kaamelott</b>…</p>',
    externals: { thetvdb: 79175, imdb: 'tt0441059' },
    ...overrides,
  },
});

describe('TvmazeProvider', () => {
  let provider: TvmazeProvider;

  beforeEach(() => {
    jest.resetAllMocks();
    provider = new TvmazeProvider(config());
  });

  it('mappe le show TVmaze vers MetadataEnriched (poster, synopsis strippé, genres, année)', async () => {
    respond([show()]);
    const result = await provider.search('Kaamelott');
    expect(result).toMatchObject({
      source: 'tvmaze',
      mediaType: 'tv',
      title: 'Kaamelott',
      posterUrl: 'https://img/original.jpg',
      overview: 'Le roi Kaamelott…',
      genres: ['Comedy'],
      year: 2005,
      voteAverage: 8.4,
      trailerUrl: null,
    });
  });

  it('privilégie la correspondance exacte du nom (pas le meilleur score flou)', async () => {
    respond([
      { score: 0.95, show: { ...show().show, id: 2, name: 'Kaamelott Livre V' } },
      { score: 0.72, show: show().show },
    ]);
    const result = await provider.search('Kaamelott');
    expect(result?.externalId).toBe('tt0441059');
    expect(result?.title).toBe('Kaamelott');
  });

  it('privilégie la correspondance d\u2019année quand fournie', async () => {
    respond([
      { score: 0.9, show: { ...show().show, id: 3, name: 'Battlestar', premiered: '1978-01-01' } },
      { score: 0.85, show: { ...show().show, id: 4, name: 'Battlestar', premiered: '2004-01-01' } },
    ]);
    const result = await provider.search('Battlestar', 2004);
    expect(result?.year).toBe(2004);
  });

  it('rejette un meilleur score flou trop faible (< 0.7)', async () => {
    respond([{ score: 0.42, show: { ...show().show, name: 'Kaamélot des étoiles' } }]);
    const result = await provider.search('Kaamelott');
    expect(result).toBeNull();
  });

  it('retombe sur Fanart.tv quand TVmaze n\u2019a pas d\u2019image (sans clé → null, pas de crash)', async () => {
    respond([show({ image: null })]);
    const result = await provider.search('Kaamelott');
    expect(result).toMatchObject({ posterUrl: null, backdropUrl: null, title: 'Kaamelott' });
  });
});

describe('stripHtml', () => {
  it('retire les balises et décode les entités courantes', () => {
    expect(stripHtml('<p>Une &amp; une &#39;apostrophe&#39; &quot;cité&quot;</p>')).toBe('Une & une \'apostrophe\' "cité"');
  });
});
