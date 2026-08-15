import { rewriteM3u8 } from './hls-rewriter';

const BASE = 'https://provider.example.com/iptv/u/p/playlist.m3u8';
let aliasCounter = 0;

function aliasResolver(_absoluteUrl: string): string {
  aliasCounter += 1;
  return `/api/stream/sid/f/a${aliasCounter}`;
}

function assertNoProviderUrl(content: string): void {
  expect(content).not.toContain('provider.example.com');
}

describe('rewriteM3u8', () => {
  beforeEach(() => {
    aliasCounter = 0;
  });

  it('réécrit les variantes d’un master playlist sans exposer l’hôte', () => {
    const master = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"',
      'http://provider.example.com/hls/720p/playlist.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=2560000,RESOLUTION=1920x1080',
      'http://provider.example.com/hls/1080p/playlist.m3u8',
      '',
    ].join('\n');

    const rewritten = rewriteM3u8(master, BASE, aliasResolver);

    expect(rewritten).toContain('#EXT-X-STREAM-INF:BANDWIDTH=1280000');
    expect(rewritten).toContain('/api/stream/sid/f/a1');
    expect(rewritten).toContain('/api/stream/sid/f/a2');
    expect(aliasCounter).toBe(2);
    assertNoProviderUrl(rewritten);
  });

  it('réécrit les segments d’une playlist média (relatifs et absolus)', () => {
    const media = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:10',
      '#EXTINF:9.0,',
      '../seg/seg-001.ts',
      '#EXTINF:9.0,',
      'https://provider.example.com/iptv/u/p/seg-002.ts',
      '#EXT-X-ENDLIST',
    ].join('\n');

    const rewritten = rewriteM3u8(media, BASE, aliasResolver);

    expect(rewritten).toContain('/api/stream/sid/f/a1');
    expect(rewritten).toContain('/api/stream/sid/f/a2');
    expect(rewritten).toContain('#EXTINF:9.0,');
    expect(aliasCounter).toBe(2);
    assertNoProviderUrl(rewritten);
  });

  it('réécrit la clé AES-128 (EXT-X-KEY) et EXT-X-MAP', () => {
    const playlist = [
      '#EXTM3U',
      '#EXT-X-KEY:METHOD=AES-128,URI="https://provider.example.com/key/0.key",IV=0x0001',
      '#EXT-X-MAP:URI="init.mp4",BYTERANGE="720@0"',
      '#EXTINF:9.0,',
      'seg.m4s',
    ].join('\n');

    const rewritten = rewriteM3u8(playlist, BASE, aliasResolver);

    expect(rewritten).toContain('METHOD=AES-128,URI="/api/stream/sid/f/a1"');
    expect(rewritten).toContain('IV=0x0001');
    expect(rewritten).toContain('URI="/api/stream/sid/f/a2"');
    expect(rewritten).toContain('BYTERANGE="720@0"');
    expect(rewritten).toContain('/api/stream/sid/f/a3');
    assertNoProviderUrl(rewritten);
  });

  it('résout correctement les références relatives (montée de répertoire)', () => {
    const master = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=512000',
      '../720p/playlist.m3u8',
    ].join('\n');

    const seen: string[] = [];
    rewriteM3u8(master, BASE, (absoluteUrl) => {
      seen.push(absoluteUrl);
      return '/api/stream/sid/f/x';
    });

    expect(seen[0]).toBe('https://provider.example.com/iptv/u/720p/playlist.m3u8');
  });

  it('laisse les tags sans URI et les commentaires intacts', () => {
    const playlist = [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:10',
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXT-X-DISCONTINUITY',
      '#EXTINF:9.0,',
      'seg.ts',
    ].join('\n');

    const rewritten = rewriteM3u8(playlist, BASE, aliasResolver);

    expect(rewritten).toContain('#EXT-X-TARGETDURATION:10');
    expect(rewritten).toContain('#EXT-X-DISCONTINUITY');
    expect(rewritten).toContain('/api/stream/sid/f/a1');
  });

  it('ignore les URLs non http(s) et ne crée pas d’alias', () => {
    const playlist = ['#EXTM3U', '#EXT-X-KEY:METHOD=SAMPLE-AES', 'data:text/plain,x'].join('\n');
    const rewritten = rewriteM3u8(playlist, BASE, aliasResolver);
    expect(aliasCounter).toBe(0);
    expect(rewritten).toContain('data:text/plain,x');
  });
});
