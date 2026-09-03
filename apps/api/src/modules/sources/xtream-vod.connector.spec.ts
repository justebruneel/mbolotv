import { fetchXtreamVodEntries } from './xtream-vod.connector';

jest.mock('node:dns/promises', () => ({
  lookup: jest.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}));

const fetchMock = jest.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('xtream-vod.connector', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('mappe get_vod_streams et get_series en entrées VOD', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse([{ category_id: '1', category_name: 'Action' }]))
      .mockResolvedValueOnce(jsonResponse([{ category_id: '2', category_name: 'Drame' }]))
      .mockResolvedValueOnce(
        jsonResponse({
          vod_streams: [
            { stream_id: 10, name: 'Film A', stream_icon: 'http://cdn/a.png', rating: '7.8', added: 1700000000, category_id: '1', container_extension: 'mkv' },
            { stream_id: 11, name: '##### FOLDER #####', stream_id_placeholder: true },
            { name: 'Sans id' },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          series: [{ series_id: 20, name: 'Série B', cover: 'http://cdn/b.jpg', rating: '8.1', last_modified: 1710000000, category_name: 'Drame' }],
        }),
      );

    const { movies, series } = await fetchXtreamVodEntries({ url: 'http://xtream.example.com/', username: 'u', password: 'p' });

    expect(movies).toHaveLength(1);
    expect(movies[0]).toMatchObject({ kind: 'MOVIE', externalId: '10', title: 'Film A', categoryTitle: 'Action', containerExt: 'mkv', rating: 7.8 });
    expect(movies[0].addedAt?.toISOString()).toBe(new Date(1700000000 * 1000).toISOString());
    expect(movies[0].locator).toBe('http://xtream.example.com/movie/u/p/10.mkv');
    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({ kind: 'SERIES', externalId: '20', title: 'Série B', categoryTitle: 'Drame' });
    const locator = JSON.parse(series[0].locator) as Record<string, string>;
    expect(locator).toMatchObject({ type: 'xtream-series', base: 'http://xtream.example.com', username: 'u', password: 'p', seriesId: '20' });
    expect(String(fetchMock.mock.calls[0][0])).toContain('action=get_vod_categories');
    expect(String(fetchMock.mock.calls[1][0])).toContain('action=get_series_categories');
    expect(String(fetchMock.mock.calls[2][0])).toContain('action=get_vod_streams');
    expect(String(fetchMock.mock.calls[3][0])).toContain('action=get_series');
  });

  it('échoue si les identifiants sont refusés', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ user_info: { auth: 0 } }));
    await expect(fetchXtreamVodEntries({ url: 'http://xtream.example.com', username: 'u', password: 'p' })).rejects.toThrow('Identifiants Xtream invalides');
  });

  it('résiste aux catégories indisponibles (titre de catégorie absent)', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('pouet', { status: 500 }))
      .mockResolvedValueOnce(new Response('pouet', { status: 500 }))
      .mockResolvedValueOnce(jsonResponse([{ stream_id: 30, name: 'Film C', category_id: '9' }]))
      .mockResolvedValueOnce(jsonResponse([]));
    const { movies } = await fetchXtreamVodEntries({ url: 'http://xtream.example.com', username: 'u', password: 'p' });
    expect(movies).toHaveLength(1);
    expect(movies[0].categoryTitle).toBeNull();
  });
});
