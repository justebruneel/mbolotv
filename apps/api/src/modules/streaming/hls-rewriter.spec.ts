import { rewriteM3u8 } from './hls-rewriter';

const BASE = 'https://provider.example.com/iptv/u/p/playlist.m3u8';
let aliasCounter = 0;
const aliasResolver = (_absoluteUrl: string): string => `/api/stream/sid/f/a${++aliasCounter}`;

describe('rewriteM3u8', () => {
  beforeEach(() => { aliasCounter = 0; });
  it('réécrit les variantes master et masque le fournisseur', async () => {
    const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1280000\nhttp://provider.example.com/hls/720p/playlist.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2560000\nhttp://provider.example.com/hls/1080p/playlist.m3u8';
    const rewritten = await rewriteM3u8(master, BASE, aliasResolver);
    expect(rewritten).toContain('/api/stream/sid/f/a1');
    expect(rewritten).toContain('/api/stream/sid/f/a2');
    expect(rewritten).not.toContain('provider.example.com');
  });
  it('réécrit segments, clés, maps et preload hints', async () => {
    const playlist = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://provider.example.com/key"\n#EXT-X-MAP:URI="init.mp4"\n#EXT-X-PRELOAD-HINT:TYPE=PART,URI="next.m4s"\n#EXTINF:9,\nseg.ts';
    const rewritten = await rewriteM3u8(playlist, BASE, aliasResolver);
    expect(rewritten).toContain('URI="/api/stream/sid/f/a1"');
    expect(rewritten).toContain('URI="/api/stream/sid/f/a2"');
    expect(rewritten).toContain('URI="/api/stream/sid/f/a3"');
    expect(rewritten).toContain('/api/stream/sid/f/a4');
  });
  it('résout les références relatives', async () => {
    const seen: string[] = [];
    await rewriteM3u8('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=512000\n../720p/playlist.m3u8', BASE, (url) => { seen.push(url); return '/alias'; });
    expect(seen[0]).toBe('https://provider.example.com/iptv/u/720p/playlist.m3u8');
  });
  it('conserve les tags sans URI et ignore les schémas non HTTP', async () => {
    const rewritten = await rewriteM3u8('#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXT-X-KEY:METHOD=SAMPLE-AES\ndata:text/plain,x', BASE, aliasResolver);
    expect(rewritten).toContain('#EXT-X-TARGETDURATION:10');
    expect(rewritten).toContain('data:text/plain,x');
    expect(aliasCounter).toBe(0);
  });
});
