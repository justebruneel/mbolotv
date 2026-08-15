import { fetchXtreamEntries } from './xtream.connector';
import { fetchMacPortalEntries } from './mac-portal.connector';

jest.mock('node:dns/promises', () => ({
  lookup: jest.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}));

const fetchMock = jest.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('xtream.connector', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('mappe live_streams en chaînes avec URL chiffrée', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(
        jsonResponse({
          live_streams: [
            {
              num: 1,
              name: 'Mango TV',
              stream_id: 101,
              stream_icon: 'http://cdn/logo.png',
              epg_channel_id: 'mango.fr',
              category_id: 5,
            },
            { num: 2, name: 'Radio XYZ', stream_type: 'radio', stream_id: 102 },
            { stream_id: 103, stream_type: 'live' },
            { num: 4, name: '##### FOLDER #####', stream_id: 104 },
          ],
        }),
      );

    const { entries } = await fetchXtreamEntries({
      url: 'http://xtream.example.com/panel/',
      username: 'user@x',
      password: 'p@ss',
    });

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      title: 'Mango TV',
      tvgId: 'mango.fr',
      groupTitle: undefined,
      tvgLogo: 'http://cdn/logo.png',
    });
    expect(entries[1]).toMatchObject({ title: 'Chaîne 103' });
    expect(entries.some((entry) => entry.title.includes('FOLDER'))).toBe(false);
    expect(entries[0].url).toBe('http://xtream.example.com/panel/live/user%40x/p%40ss/101.m3u8');
    expect(String(fetchMock.mock.calls[0][0])).toContain('action=get_live_categories');
    expect(String(fetchMock.mock.calls[1][0])).toContain(
      'player_api.php?username=user%40x&password=p%40ss&action=get_live_streams',
    );
  });

  it('groupe les chaînes par catégorie renvoyée par get_live_categories', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse([
          { category_id: '1382', category_name: 'VIP | GOLDEN EVENTS' },
          { category_id: '1383', category_name: 'VIP | MUSIC CONCERTS' },
        ]),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          live_streams: [
            { num: 1, name: 'Event A', stream_id: 1, category_id: '1382' },
            { num: 2, name: 'Event B', stream_id: 2, category_id: '1383' },
          ],
        }),
      );

    const { entries } = await fetchXtreamEntries({
      url: 'http://xtream.example.com',
      username: 'a',
      password: 'b',
    });

    expect(entries).toHaveLength(2);
    expect(entries[0].groupTitle).toBe('VIP | GOLDEN EVENTS');
    expect(entries[1].groupTitle).toBe('VIP | MUSIC CONCERTS');
  });

  it('retourne une liste vide si live_streams est absent', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse({ user_info: {} }));
    const { entries } = await fetchXtreamEntries({
      url: 'http://xtream.example.com',
      username: 'a',
      password: 'b',
    });
    expect(entries).toEqual([]);
  });

  it('échoue si la réponse n’est pas du JSON valide', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(new Response('<html>pas json</html>', { status: 200 }));
    await expect(
      fetchXtreamEntries({ url: 'http://xtream.example.com', username: 'a', password: 'b' }),
    ).rejects.toThrow('JSON attendu');
  });

  it('échoue si le portail répond en erreur HTTP', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('nope', { status: 401 }))
      .mockResolvedValueOnce(new Response('nope', { status: 401 }));
    await expect(
      fetchXtreamEntries({ url: 'http://xtream.example.com', username: 'a', password: 'b' }),
    ).rejects.toThrow('Réponse HTTP 401');
  });
});

describe('mac-portal.connector', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('effectue le handshake Stalker et mappe les chaînes', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ js: { token: 'tok-123' } }))
      .mockResolvedValueOnce(jsonResponse({ js: [{ id: 1, title: 'Sports' }] }))
      .mockResolvedValueOnce(
        jsonResponse({
          js: [
            { id: 42, name: 'Mango TV', number: 5, genres: [1], logo: 'http://cdn/logo.png' },
            { id: 43, name: 'Sans genre' },
          ],
        }),
      );

    const { entries } = await fetchMacPortalEntries({
      url: 'http://portal.example.com/c/',
      macAddress: '00:1a:79:11:22:33',
    });

    expect(String(fetchMock.mock.calls[0][0])).toContain('action=handshake');
    expect((fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers.MAC).toBe(
      '00:1A:79:11:22:33',
    );
    expect(String(fetchMock.mock.calls[1][0])).toContain('action=get_genres');
    expect(String(fetchMock.mock.calls[2][0])).toContain('action=get_all_channels');

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      title: 'Mango TV',
      groupTitle: 'Sports',
      tvgLogo: 'http://cdn/logo.png',
    });
    expect(entries[0].url).toBe('http://portal.example.com/c/play/live/tok-123/42.ts');
    expect(entries[1].groupTitle).toBeUndefined();
  });

  it('échoue si le handshake ne fournit pas de token', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ js: {} }));
    await expect(
      fetchMacPortalEntries({ url: 'http://portal.example.com', macAddress: '00:1a:79:11:22:33' }),
    ).rejects.toThrow('Aucun token');
  });

  it('ne bloque pas sur des genres indisponibles', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ js: { token: 't' } }))
      .mockResolvedValueOnce(new Response('pouet', { status: 500 }))
      .mockResolvedValueOnce(jsonResponse({ js: [{ id: 7, name: 'Chaîne 7' }] }));

    const { entries } = await fetchMacPortalEntries({
      url: 'http://portal.example.com',
      macAddress: '00:1a:79:11:22:33',
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].title).toBe('Chaîne 7');
    expect(entries[0].groupTitle).toBeUndefined();
  });
});
