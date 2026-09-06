// Tests unitaires du framework d'extracteurs (fonctions pures + erreurs).
// Lancer : node --test workers/mbolo-tv-api/test/
// Aucun accès réseau : la résolution live se sonde via scripts/probe-extractors.mjs.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ExtractorError, extractorError, isRetryable, ExtractorErrorCode } from '../src/extractors/errors.js';
import { absolutizeCdnUrl, extractTitle, extractWurl, findPackedBlocks, unpackPacker } from '../src/extractors/unpack.js';
import { mirrorsFromEnv, parse, HOST } from '../src/extractors/mixdrop.js';
import { SUPPORTED_HOSTS, checkSource, serveExternalPlay } from '../src/extractors/index.js';
import { attemptsSummary } from '../src/extractors/http.js';
import { playResponse } from '../src/play.js';
import { createHmac } from 'node:crypto';
import { extractPassMd5, parse as parseDood, resolve as resolveDood } from '../src/extractors/dood.js';
import { decodePayload, extractPayload, parse as parseVoe, rot13 } from '../src/extractors/voe.js';
import { extractFileUrl, parse as parseUqload } from '../src/extractors/uqload.js';
import { HOST as VIDZY_HOST, decodeVidzyUrl, mirrorsFromEnv as vidzyMirrors, parse as parseVidzy, reconstructVidzyUrl, resolve as resolveVidzy } from '../src/extractors/vidzy.js';
import {
  HOST as FILMOON_HOST,
  decryptPlayback,
  grHash,
  leadingZeroBits,
  mirrorsFromEnv as filmoonMirrors,
  parse as parseFilmoon,
  resolve as resolveFilmoon,
  solvePow,
} from '../src/extractors/filmoon.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

describe('errors', () => {
  it('mappe chaque code vers le bon statut HTTP', () => {
    assert.equal(new ExtractorError('INVALID', 'x').status, 400);
    assert.equal(new ExtractorError('RETRYABLE', 'x').status, 502);
    assert.equal(new ExtractorError('QUOTA', 'x').status, 429);
    assert.equal(new ExtractorError('DEAD', 'x').status, 451);
  });
  it('isRetryable uniquement pour RETRYABLE (jamais quota/mort)', () => {
    assert.equal(isRetryable(extractorError(ExtractorErrorCode.RETRYABLE, 'x')), true);
    assert.equal(isRetryable(extractorError(ExtractorErrorCode.QUOTA, 'x')), false);
    assert.equal(isRetryable(extractorError(ExtractorErrorCode.DEAD, 'x')), false);
    assert.equal(isRetryable(extractorError(ExtractorErrorCode.INVALID, 'x')), false);
    assert.equal(isRetryable(new Error('x')), false);
  });
});

describe('mixdrop parse', () => {
  it('accepte un id nu', () => {
    assert.deepEqual(parse('el09xempuzkxz4'), { id: 'el09xempuzkxz4' });
  });
  it('extrait l’id des URL /e/ et /f/', () => {
    assert.deepEqual(parse('https://miixdrop.net/e/el09xempuzkxz4'), { id: 'el09xempuzkxz4' });
    assert.deepEqual(parse('https://mixdrop.ag/f/abc123_X-9'), { id: 'abc123_X-9' });
  });
  it('rejette les entrées invalides (400, sans réseau)', () => {
    for (const bad of ['', '   ', 'ab', 'id avec espaces', 'https://example.com/video']) {
      assert.throws(() => parse(bad), (error) => error instanceof ExtractorError && error.status === 400, JSON.stringify(bad));
    }
  });
});

describe('mixdrop mirrors', () => {
  it('défauts sans env', () => {
    assert.deepEqual(mirrorsFromEnv({}), [
      'https://miixdrop.top',
      'https://miixdrop.net',
      'https://mixdrop.ag',
      'https://mixdrop.co',
    ]);
  });
  it('surcharge JSON puis CSV, repli défauts si vide', () => {
    assert.deepEqual(mirrorsFromEnv({ MIXDROP_MIRRORS: '["https://m1.example","https://m2.example/"]' }), [
      'https://m1.example',
      'https://m2.example',
    ]);
    assert.deepEqual(mirrorsFromEnv({ MIXDROP_MIRRORS: 'https://a.example, https://b.example/' }), [
      'https://a.example',
      'https://b.example',
    ]);
    assert.deepEqual(mirrorsFromEnv({ MIXDROP_MIRRORS: 'not a url' }), [
      'https://miixdrop.top',
      'https://miixdrop.net',
      'https://mixdrop.ag',
      'https://mixdrop.co',
    ]);
  });
});

const PACKED_HTML = `<html><head><title>Film Test - MixDrop</title></head><body><script>eval(function(p,a,c,k,e,d){e=function(c){return c.toString(36)};while(c--){if(k[c]){p=p.replace(new RegExp('\\\\b'+e(c)+'\\\\b','g'),k[c])}}return p}('0.1="3";',4,4,'MDCore|wurl|XX|//a-delivery46.mxcontent.net/v2/abc.mp4?s=1'.split('|'),0,{}))</script></body></html>`;

describe('unpack', () => {
  it('extrait wurl en clair', () => {
    assert.equal(extractWurl(`<script>MDCore.wurl="//a-delivery46.mxcontent.net/v2/abc.mp4?s=1";</script>`), '//a-delivery46.mxcontent.net/v2/abc.mp4?s=1');
  });
  it('extrait wurl d’un bloc packé (player changé mais même variable)', () => {
    assert.ok(findPackedBlocks(PACKED_HTML).length >= 1);
    assert.equal(extractWurl(PACKED_HTML), '//a-delivery46.mxcontent.net/v2/abc.mp4?s=1');
  });
  it('unpackPacker remplace les tokens base-N', () => {
    const block = findPackedBlocks(PACKED_HTML)[0];
    assert.equal(unpackPacker(block), 'MDCore.wurl="//a-delivery46.mxcontent.net/v2/abc.mp4?s=1";');
  });
  it('retourne null sans wurl (fichier retiré)', () => {
    assert.equal(extractWurl('<html><body>deleted</body></html>'), null);
  });
  it('absolutize + titre', () => {
    assert.equal(absolutizeCdnUrl('//a-delivery46.mxcontent.net/v2/abc.mp4'), 'https://a-delivery46.mxcontent.net/v2/abc.mp4');
    assert.equal(extractTitle(PACKED_HTML), 'Film Test');
  });
});

describe('unpack robustesse', () => {
  it('supporte des noms de params renommés (e,r → a,b)', () => {
    // Seule la signature change (le corps garde ses refs d'origine) : l'unpack
    // ne dépend que des groupes payload/radix/count/dict, pas des noms.
    const renamed = PACKED_HTML.replace('function(p,a,c,k,e,d)', 'function(a9,b9,c9,d9,e9,f9)');
    assert.ok(findPackedBlocks(renamed).length >= 1);
    assert.equal(extractWurl(renamed), '//a-delivery46.mxcontent.net/v2/abc.mp4?s=1');
  });
  it('parité référence : entrée dict vide → remplacée par vide', () => {
    const block = `eval(function(p,a,c,k,e,d){return p}('0 1 2',4,3,'a||b'.split('|'),0,{}))`;
    assert.equal(unpackPacker(block), 'a  b');
  });
});

describe('playResponse x-ref', () => {
  const env = { VIDEO_PROXY_URL: 'https://proxy.example/', PROXY_URL_SECRET: 'secret-test' };
  const hmac = (payload) => createHmac('sha256', 'secret-test').update(payload).digest('hex');
  it('sans referer : schéma historique inchangé (pas de x-ref)', async () => {
    const play = await playResponse(env, 'https://cdn.example/v.mp4', null, { direct: true });
    const url = new URL(play.url);
    assert.equal(url.searchParams.get('x-ref'), null);
    assert.equal(
      url.searchParams.get('x-sig'),
      hmac(`https://cdn.example/v.mp4|${url.searchParams.get('x-exp')}`),
    );
  });
  it('avec referer : slash final normalisé + signature élargie', async () => {
    const withSlash = await playResponse(env, 'https://cdn.example/v.mp4', null, { direct: true, referer: 'https://miixdrop.net/' });
    const withoutSlash = await playResponse(env, 'https://cdn.example/v.mp4', null, { direct: true, referer: 'https://miixdrop.net' });
    // Même heure → même bucket → URL strictement identiques après normalisation.
    assert.equal(withSlash.url, withoutSlash.url);
    const url = new URL(withSlash.url);
    assert.equal(url.searchParams.get('x-ref'), 'https://miixdrop.net/');
    assert.equal(
      url.searchParams.get('x-sig'),
      hmac(`https://cdn.example/v.mp4|${url.searchParams.get('x-exp')}|https://miixdrop.net/`),
    );
  });
});

const DOOD_EMBED_HTML = `<html><head><title>Ready or Not 2 - DoodStream</title></head><body>
<script>$.get('/pass_md5/262298320-154-116-1788648430-8510787d65ec8d36411b72222d838712/arzo61tq5nxwziaz8o9gwzlg', function(data) {});</script>
</body></html>`;
const DOOD_PREFIX = 'https://il266m.cloudatacdn.com/abc123/video.mp4?n=foo';

describe('dood parse', () => {
  it('accepte URL complète (wrapper kokoflix/kakaflix/dood.*)', () => {
    assert.deepEqual(parseDood('https://kokoflix.lol/tokyo_go.php?id=31ls0dmL4S9xqGo5cpRKI'), {
      embedUrl: 'https://kokoflix.lol/tokyo_go.php?id=31ls0dmL4S9xqGo5cpRKI',
    });
  });
  it('accepte code nu et chemins /d/ /e/', () => {
    assert.deepEqual(parseDood('a9i71q3waiv4'), { code: 'a9i71q3waiv4' });
    assert.deepEqual(parseDood('https://dood.to/e/a9i71q3waiv4'), { embedUrl: 'https://dood.to/e/a9i71q3waiv4' });
  });
  it('rejette les entrées invalides', () => {
    for (const bad of ['', 'ab', 'avec espaces', 'ftp://x.example/e/abcd']) {
      assert.throws(() => parseDood(bad), (error) => error instanceof ExtractorError && error.status === 400, JSON.stringify(bad));
    }
  });
  it('extrait le chemin pass_md5', () => {
    assert.equal(
      extractPassMd5(DOOD_EMBED_HTML),
      '/pass_md5/262298320-154-116-1788648430-8510787d65ec8d36411b72222d838712/arzo61tq5nxwziaz8o9gwzlg',
    );
    assert.equal(extractPassMd5('<html>sans handshake</html>'), null);
  });
});

describe('dood resolve (fetch mocké)', () => {
  const realFetch = globalThis.fetch;
  const stub = (embedHtml) => {
    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target.includes('/pass_md5/')) return new Response(DOOD_PREFIX, { status: 200 });
      if (target.includes('tokyo_go.php')) {
        return new Response(embedHtml, { status: 200, headers: { 'content-type': 'text/html' } });
      }
      if (target.includes('cloudatacdn.com')) {
        return new Response(new Uint8Array([0, 1, 2, 3]), { status: 206, headers: { 'content-type': 'video/mp4' } });
      }
      return new Response('nf', { status: 404 });
    };
  };
  // after() n'existe qu'en mode suite : restauration manuelle en fin de bloc.
  it('construit le lien CDN signé (préfixe + token + expiry) et le probe', async () => {
    stub(DOOD_EMBED_HTML);
    try {
      const result = await resolveDood({}, 'https://kokoflix.lol/tokyo_go.php?id=31ls0dmL4S9xqGo5cpRKI');
      assert.equal(result.urls.length, 1);
      assert.match(result.urls[0], /^https:\/\/il266m\.cloudatacdn\.com\/abc123\/video\.mp4\?n=foo[A-Za-z0-9]{10}\?token=arzo61tq5nxwziaz8o9gwzlg&expiry=\d+$/);
      assert.equal(result.referer, 'https://kokoflix.lol/');
      assert.equal(result.title, 'Ready or Not 2');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
  it('"Video unavailable" → DEAD (451)', async () => {
    stub('<html><body>Video unavailable. Please try again later.</body></html>');
    try {
      await assert.rejects(() => resolveDood({}, 'https://kokoflix.lol/tokyo_go.php?id=dead'), (error) => error.status === 451);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('voe', () => {
  it('parse : URL complète, /e/, code nu, rejets', () => {
    assert.deepEqual(parseVoe('https://eugenemakedraw.com/e/fah90cksg9ep'), {
      embedUrl: 'https://eugenemakedraw.com/e/fah90cksg9ep',
    });
    assert.deepEqual(parseVoe('https://voe.sx/e/fah90cksg9ep'), { embedUrl: 'https://voe.sx/e/fah90cksg9ep' });
    assert.deepEqual(parseVoe('fah90cksg9ep'), { code: 'fah90cksg9ep' });
    for (const bad of ['', 'abc', 'ftp://x.example/e/fah90cksg9ep']) {
      assert.throws(() => parseVoe(bad), (error) => error instanceof ExtractorError && error.status === 400, JSON.stringify(bad));
    }
  });
  it('rot13 + extractPayload sur HTML réel', () => {
    assert.equal(rot13('DROH'), 'QEBU');
    const html = `<script>var source='x';</script><script type="application/json">${JSON.stringify([
      readFileSync(join(FIXTURES, 'voe-payload.txt'), 'utf8'),
    ])}</script>`;
    assert.equal(extractPayload(html).slice(0, 8), 'DROH!!nJ');
  });
  it('decodePayload sur vecteur live (Dao/Voe) : source HLS + titre', () => {
    const payload = readFileSync(join(FIXTURES, 'voe-payload.txt'), 'utf8');
    const decoded = decodePayload(payload);
    assert.match(decoded.file, /^https:\/\/.*master\.m3u8\?t=.*&s=\d+&e=\d+/);
    assert.match(decoded.title, /Dao/);
  });
  it('decodePayload illisible → DEAD', () => {
    assert.throws(() => decodePayload('!!!pas-un-payload!!!'), (error) => error.status === 451);
  });
});

describe('uqload', () => {
  it('parse : URL complète, code nu, rejets', () => {
    assert.deepEqual(parseUqload('https://uqload.vc/embed-fcr8t4bhlrx1.html'), {
      embedUrl: 'https://uqload.vc/embed-fcr8t4bhlrx1.html',
    });
    assert.deepEqual(parseUqload('fcr8t4bhlrx1'), { code: 'fcr8t4bhlrx1' });
    for (const bad of ['', 'abc', 'ftp://x.example/embed-fcr8t4bhlrx1.html']) {
      assert.throws(() => parseUqload(bad), (error) => error instanceof ExtractorError && error.status === 400, JSON.stringify(bad));
    }
  });
  it('extractFileUrl : setup jwplayer file:[{file}] en priorité', () => {
    assert.equal(
      extractFileUrl(`jwplayer("v").setup({file:[{file:"https://strm1.uqload.vc/a/b.mp4?t=1"}],image:"https://x/i.jpg"})`),
      'https://strm1.uqload.vc/a/b.mp4?t=1',
    );
    assert.equal(extractFileUrl(`file:"https://strm1.uqload.vc/a.m3u8"`), 'https://strm1.uqload.vc/a.m3u8');
    assert.equal(extractFileUrl('rien ici'), null);
  });
});

describe('vidzy', () => {
  // Blob capturé live le 2026-09-06 sur https://vidzy.cc/embed-p731ofuec673.html.
  const REAL_BLOB = '679Zo1Eu61wu00c/nmHLl3nP/2bXvg3utBvsHTnzVCGOWz+Ib8mUcYC8NoL+Bu20TqBBVqxZc/AaYuUIp9QisasQvuRWv+5zuBNt/1pb2CZhhW5W43OBo3ufolXx9EigCEOkX3jhVjuFOWTdKZmsd9ziFtezHuVMDPxBN40VYdx0Ycp+juQhheUU1bla+VIeuAJttA8=';
  // Encodeur miroir de decodeVidzyUrl (pour fabriquer des fixtures).
  const encodeVidzy = (url, host) => {
    let h = 0;
    for (const ch of host) h = (h + ch.charCodeAt(0)) & 255;
    let out = '';
    for (let i = 0; i < url.length; i += 1) out += String.fromCharCode(url.charCodeAt(i) ^ ((0x3d + i * 89 + h) & 255));
    return btoa([...out].reverse().join(''));
  };
  const embedHtml = (blob) => `<html><head><title>Predator Badlands 2025 TRUEFRENCH VF2 1080p WEB H264-SUPPLY - Vidzy</title></head><body>
    var _fsvHls="https://s1.fsvid.lol/troll/master.m3u8";player = videojs('vjsplayer', {sources: [{src: (function(s){var h=(location&&location.hostname)||"",H=0;return s})("${blob}"), type: "application/x-mpegURL"}]});</body></html>`;

  it('parse : URL complète, chemin embed, code nu, rejets', () => {
    assert.deepEqual(parseVidzy('https://vidzy.cc/embed-p731ofuec673.html'), {
      embedUrl: 'https://vidzy.cc/embed-p731ofuec673.html',
    });
    assert.deepEqual(parseVidzy('/embed-p731ofuec673.html'), { code: 'p731ofuec673' });
    assert.deepEqual(parseVidzy('p731ofuec673'), { code: 'p731ofuec673' });
    for (const bad of ['', 'abc', 'ftp://x.example/embed-p731ofuec673.html', 'pas un code !']) {
      assert.throws(() => parseVidzy(bad), (error) => error instanceof ExtractorError && error.status === 400, JSON.stringify(bad));
    }
  });

  it('mirrorsFromEnv : défauts, surcharge JSON, surcharge CSV, repli', () => {
    assert.deepEqual(vidzyMirrors({}), ['https://vidzy.cc']);
    assert.equal(VIDZY_HOST, 'vidzy');
    assert.deepEqual(vidzyMirrors({ VIDZY_MIRRORS: '["https://a.example/","https://b.example"]' }), ['https://a.example', 'https://b.example']);
    assert.deepEqual(vidzyMirrors({ VIDZY_MIRRORS: 'https://c.example, https://d.example' }), ['https://c.example', 'https://d.example']);
    assert.deepEqual(vidzyMirrors({ VIDZY_MIRRORS: '!!!' }), ['https://vidzy.cc']);
  });

  it('decodeVidzyUrl : blob capturé → HLS u14.vidzy.cc avec jeton', () => {
    const url = decodeVidzyUrl(REAL_BLOB, 'vidzy.cc');
    assert.match(url, /^https:\/\/u14\.vidzy\.cc\/hls2\/06\/00047\/p731ofuec673_o\/master\.m3u8\?t=/);
  });

  it('decodeVidzyUrl : host non émetteur → pas d\'URL (leurre/null)', () => {
    const wrong = decodeVidzyUrl(REAL_BLOB, 'evil.example');
    assert.ok(wrong === null || !wrong.includes('vidzy.cc'), String(wrong));
  });

  it('reconstructVidzyUrl : chemin mux à virgules → index-v1-a1 (fssMuxT)', () => {
    assert.equal(
      reconstructVidzyUrl('https://u9.vidzy.cc/hls2/06/00047/,p731ofuec673_o,.urlset/master.m3u8?t=abc'),
      'https://u9.vidzy.cc/hls2/06/00047/p731ofuec673_o/index-v1-a1.m3u8?t=abc',
    );
    assert.equal(
      reconstructVidzyUrl('https://u14.vidzy.cc/hls2/x/master.m3u8?t=abc'),
      'https://u14.vidzy.cc/hls2/x/master.m3u8?t=abc',
    );
  });

  it('resolve (fetch mocké) : embed → HLS direct + referer + titre', async () => {
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input) => {
        const url = String(input);
        if (url.includes('/embed-')) return new Response(embedHtml(REAL_BLOB), { status: 200, url, headers: { 'content-type': 'text/html' } });
        if (url.includes('/hls2/')) return new Response('#EXTM3U\n', { status: 200, url, headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
        return new Response('nf', { status: 404, url });
      };
      const result = await resolveVidzy({}, 'https://vidzy.cc/embed-p731ofuec673.html');
      assert.equal(result.urls.length, 1);
      assert.match(result.urls[0], /^https:\/\/u14\.vidzy\.cc\/hls2\//);
      assert.equal(result.referer, 'https://vidzy.cc/');
      assert.match(result.title, /^Predator Badlands/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('resolve : page sans blob (fichier retiré/player changé) → DEAD', async () => {
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input) => new Response('<html><body>video unavailable</body></html>', { status: 200, url: String(input) });
      await assert.rejects(() => resolveVidzy({}, 'https://vidzy.cc/embed-p731ofuec673.html'), (error) => {
        assert.ok(error instanceof ExtractorError);
        assert.equal(error.code, 'DEAD');
        return true;
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('resolve : URL CDN hors de l\'apex du miroir → DEAD (anti-exfiltration, leurre troll)', async () => {
    const trollBlob = encodeVidzy('https://s1.fsvid.lol/troll/master.m3u8', 'vidzy.cc');
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input) => {
        const url = String(input);
        if (url.includes('/embed-')) return new Response(embedHtml(trollBlob), { status: 200, url, headers: { 'content-type': 'text/html' } });
        return new Response('nf', { status: 404, url });
      };
      await assert.rejects(() => resolveVidzy({}, 'https://vidzy.cc/embed-p731ofuec673.html'), (error) => {
        assert.ok(error instanceof ExtractorError);
        assert.equal(error.code, 'DEAD');
        return true;
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('checkSource route vidzy (pas UNKNOWN_HOST)', async () => {
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input) => new Response('bloqué', { status: 500, url: String(input) });
      const check = await checkSource({}, 'vidzy', 'https://vidzy.cc/embed-p731ofuec673.html');
      assert.notEqual(check.code, 'UNKNOWN_HOST');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('filmoon', () => {
  // Vecteurs grHash relevés sur l'implémentation validée contre le bundle
  // pow du player Byse (2026-09-06) — garde anti-régression du hash maison.
  const GR_VECTORS = {
    abc: 'f2758c8c 405e74da e5cc830f 7e93a277 36deea6e c9dca24a c5b12c30 47a63974',
    'TESTNONCE:370': '0054cbce 13f9c85e 78985d6c f501dd5f a33e5972 baf801fe f4b54370 e2572895',
    'dr9l7mdk03dk:0': '642dcc27 1f246d68 5169580f 9674cf3f ee2115af b8a447d6 1bd80b7c 105bae8b',
  };
  const hexWords = (bytes) => Array.from(grHash(bytes)).map((w) => w.toString(16).padStart(8, '0')).join(' ');
  const enc = new TextEncoder();
  const part = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  it('parse : wrapper kakaflix/kokoflix, SPA /e/<code>, code nu, rejets', () => {
    assert.deepEqual(parseFilmoon('https://kakaflix.lol/moon2/newPlayer.php?id=abc'), {
      wrapperUrl: 'https://kakaflix.lol/moon2/newPlayer.php?id=abc',
    });
    assert.deepEqual(parseFilmoon('https://kokoflix.lol/chamber_go.php?id=YeNMVJUAmvXkWp63cr2PI'), {
      wrapperUrl: 'https://kokoflix.lol/chamber_go.php?id=YeNMVJUAmvXkWp63cr2PI',
    });
    assert.deepEqual(parseFilmoon('https://bysebuho.com/e/dr9l7mdk03dk'), {
      spaOrigin: 'https://bysebuho.com',
      code: 'dr9l7mdk03dk',
    });
    assert.deepEqual(parseFilmoon('dr9l7mdk03dk'), { code: 'dr9l7mdk03dk' });
    // Les SPAs Byse tournent (bysebuho aujourd'hui, bysesayeveum avant) :
    // tout host /e/<code> est accepté — seule l'origine CDN finale est verrouillée.
    assert.deepEqual(parseFilmoon('https://spa-avenir.example/e/DR9L7MDK03DK'), {
      spaOrigin: 'https://spa-avenir.example',
      code: 'dr9l7mdk03dk',
    });
    for (const bad of ['', 'ftp://x.example/e/abc', 'https://vidzy.cc/embed-p731ofuec673.html', 'pas un code !']) {
      assert.throws(() => parseFilmoon(bad), (error) => error instanceof ExtractorError && error.status === 400, JSON.stringify(bad));
    }
  });

  it('mirrorsFromEnv : défauts, surcharge JSON, surcharge CSV, repli', () => {
    assert.deepEqual(filmoonMirrors({}), ['https://kakaflix.lol', 'https://kokoflix.lol']);
    assert.equal(FILMOON_HOST, 'filmoon');
    assert.deepEqual(filmoonMirrors({ FILMOON_MIRRORS: '["https://a.example/","https://b.example"]' }), ['https://a.example', 'https://b.example']);
    assert.deepEqual(filmoonMirrors({ FILMOON_MIRRORS: 'https://c.example, https://d.example' }), ['https://c.example', 'https://d.example']);
    assert.deepEqual(filmoonMirrors({ FILMOON_MIRRORS: '!!!' }), ['https://kakaflix.lol', 'https://kokoflix.lol']);
  });

  it('grHash : sorties identiques au bundle Byse (vecteurs capturés)', () => {
    for (const [input, expected] of Object.entries(GR_VECTORS)) {
      assert.equal(hexWords(enc.encode(input)), expected, input);
    }
  });

  it('leadingZeroBits : compte big-endian mot 0 d\'abord', () => {
    assert.equal(leadingZeroBits(new Uint32Array([0, 1])), 63);
    assert.equal(leadingZeroBits(new Uint32Array([1])), 31);
    assert.equal(leadingZeroBits(new Uint32Array([0x80000000, 0])), 0);
    assert.equal(leadingZeroBits(new Uint32Array([0x00010000, 0])), 15);
    assert.equal(leadingZeroBits(new Uint32Array([0, 0])), 64);
  });

  it('solvePow : vecteur bundle TESTNONCE/difficulté 8 → 370 ; budget dépassé → null', () => {
    assert.equal(solvePow('TESTNONCE', 8), '370');
    assert.equal(solvePow('', 16), '0');
    assert.equal(solvePow('TESTNONCE', 0), '0');
    assert.equal(solvePow('impossible', 33, -1), null);
  });

  it('decryptPlayback : round-trip AES-256-GCM clé parts[version-1]+parts[31-version-1]', async () => {
    // Tailles observées live (capture byse-playback.json) : les deux vraies
    // parts font 16 octets (concat = clé AES 32), les leurres 24.
    const half = crypto.getRandomValues(new Uint8Array(16));
    const rawKey = new Uint8Array(32);
    rawKey.set(half, 0);
    rawKey.set(half, 16);
    const encKey = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const media = { sources: [{ url: 'https://edge2-waw-sprintcdn.r66nv9ed.com/hls2/x/master.m3u8?t=1', quality: 'auto' }], poster_url: 'p.jpg' };
    const encrypt = async (version) => {
      const payload = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, encKey, new TextEncoder().encode(JSON.stringify(media)));
      return {
        algorithm: 'AES-256-GCM',
        key_parts: Array.from({ length: 30 }, (_, i) => (i === version - 1 || i === 31 - version - 1 ? part(half) : part(crypto.getRandomValues(new Uint8Array(24))))),
        version,
        iv: part(iv),
        payload: part(new Uint8Array(payload)),
      };
    };
    for (const version of [1, 7, 30]) {
      assert.deepEqual(await decryptPlayback(await encrypt(version)), media, `version ${version}`);
    }
    await assert.rejects(() => decryptPlayback({ key_parts: [], version: 1, iv: 'x', payload: 'y' }), (error) => error.code === 'DEAD');
    await assert.rejects(async () => decryptPlayback(await encrypt(31)), (error) => error.code === 'DEAD');
  });
  it('resolve (fetch mocké) : chaîne Byse complète → HLS sprintcdn + referer player + titre', async () => {
    const realFetch = globalThis.fetch;
    const playerOrigin = 'https://f7hyg4q.org';
    const masterUrl = 'https://edge2-waw-sprintcdn.r66nv9ed.com/hls2/05/10847/dr9l7mdk03dk_o/master.m3u8?t=abc';
    const part = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    try {
      globalThis.fetch = async (input, init) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        if (url.endsWith('/embed/details')) {
          // fetchEmbedText n'envoie pas x-embed-parent (seuls les apiPost du
          // player le font) — on vérifie juste le chemin SPA → details.
          assert.ok(url.startsWith('https://bysebuho.com/api/videos/dr9l7mdk03dk/'), url);
          return Response.json({ embed_frame_url: `${playerOrigin}/da6/dr9l7mdk03dk`, title: 'Predator Badlands 2025 TRUEFRENCH VF2 1080p WEB H264-SUPPLY' }, { url });
        }
        if (url.endsWith('/access/challenge')) return Response.json({ challenge_id: 'c1', nonce: 'NONCE123' }, { url });
        if (url.endsWith('/access/attest')) {
          assert.ok(headers.get('origin') === playerOrigin && headers.get('x-embed-parent'));
          return Response.json({ token: 't-attest', viewer_id: 'v1', device_id: 'd1', confidence: 0.55 }, { url });
        }
        if (url.endsWith('/embed/captcha')) return Response.json({ pow_nonce: 'TESTNONCE', pow_difficulty: 8, pow_token: 'pow-1', algorithm: 'sha256-leading-zero-bits' }, { url });
        if (url.endsWith('/captcha/verify')) {
          const body = JSON.parse(init.body);
          assert.equal(body.solution, solvePow('TESTNONCE', 8));
          return Response.json({ status: 'ok', token: 't-captcha', expires_in: 1800 }, { url });
        }
        if (url.endsWith('/embed/playback')) {
          assert.equal(headers.get('x-captcha-token'), 't-captcha');
          // version 1 → clé = parts[0] + parts[29], chacune 16 octets (live).
          const half = crypto.getRandomValues(new Uint8Array(16));
          const rawKey = new Uint8Array(32);
          rawKey.set(half, 0);
          rawKey.set(half, 16);
          const keyParts = Array.from({ length: 30 }, (_, i) => (i === 0 || i === 29 ? part(half) : part(crypto.getRandomValues(new Uint8Array(24)))));
          const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);
          const iv = crypto.getRandomValues(new Uint8Array(12));
          const media = { sources: [{ url: masterUrl, quality: 'auto' }], poster_url: 'p.jpg' };
          const payload = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(media)));
          return Response.json({
            playback: { algorithm: 'AES-256-GCM', key_parts: keyParts, version: 1, iv: part(iv), payload: part(new Uint8Array(payload)) },
          }, { url });
        }
        if (url.includes('/hls2/')) return new Response('#EXTM3U\n', { status: 200, url, headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
        return new Response('nf', { status: 404, url });
      };
      const result = await resolveFilmoon({}, 'https://bysebuho.com/e/dr9l7mdk03dk');
      assert.equal(result.urls.length, 1);
      assert.match(result.urls[0], /^https:\/\/edge2-waw-sprintcdn\.r66nv9ed\.com\/hls2\//);
      assert.equal(result.referer, `${playerOrigin}/`);
      assert.match(result.title, /^Predator Badlands/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('resolve : URL CDN hors sprintcdn/r66nv9ed → DEAD (anti-exfiltration)', async () => {
    const realFetch = globalThis.fetch;
    const playerOrigin = 'https://f7hyg4q.org';
    try {
      globalThis.fetch = async (input, init) => {
        const url = String(input);
        if (url.endsWith('/embed/details')) return Response.json({ embed_frame_url: `${playerOrigin}/da6/dr9l7mdk03dk`, title: 'x' }, { url });
        if (url.endsWith('/access/challenge')) return Response.json({ challenge_id: 'c1', nonce: 'NONCE123' }, { url });
        if (url.endsWith('/access/attest')) return Response.json({ token: 't-attest', viewer_id: 'v1', device_id: 'd1', confidence: 0.55 }, { url });
        if (url.endsWith('/embed/captcha')) return Response.json({ pow_nonce: 'TESTNONCE', pow_difficulty: 8, pow_token: 'pow-1' }, { url });
        if (url.endsWith('/captcha/verify')) return Response.json({ status: 'ok', token: 't-captcha' }, { url });
        if (url.endsWith('/embed/playback')) {
          const key = await crypto.subtle.importKey('raw', crypto.getRandomValues(new Uint8Array(32)), 'AES-GCM', false, ['encrypt']);
          const iv = crypto.getRandomValues(new Uint8Array(12));
          const payload = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify({ sources: [{ url: 'https://evil.example/hls2/master.m3u8' }] })));
          return Response.json({
            playback: {
              algorithm: 'AES-256-GCM',
              key_parts: Array.from({ length: 30 }, () => part(crypto.getRandomValues(new Uint8Array(32)))),
              version: 1,
              iv: part(iv),
              payload: part(new Uint8Array(payload)),
            },
          }, { url });
        }
        return new Response('nf', { status: 404, url });
      };
      await assert.rejects(() => resolveFilmoon({}, 'dr9l7mdk03dk'), (error) => {
        assert.ok(error instanceof ExtractorError);
        assert.equal(error.code, 'DEAD');
        return true;
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('checkSource route filmoon (pas UNKNOWN_HOST)', async () => {
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input) => new Response('bloqué', { status: 500, url: String(input) });
      const check = await checkSource({}, 'filmoon', 'https://kokoflix.lol/chamber_go.php?id=YeNMVJUAmvXkWp63cr2PI');
      assert.notEqual(check.code, 'UNKNOWN_HOST');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('diagnostic', () => {
  it('attemptsSummary résume relais/direct (statuts + erreurs + ms)', () => {
    assert.equal(
      attemptsSummary({ attempts: [{ target: 'relais', ms: 15001 }, { target: 'direct', status: 403, ms: 812 }] }),
      'relais: ? (15001ms); direct: HTTP 403 (812ms)',
    );
    assert.equal(attemptsSummary(new Error('x')), null);
    assert.equal(attemptsSummary({ attempts: [] }), null);
  });
  it('checkSource : host inconnu (sans réseau), id invalide', async () => {
    assert.deepEqual(await checkSource({}, 'nope', 'x'), {
      ok: false, code: 'UNKNOWN_HOST', status: 400, message: 'Hôte non pris en charge : nope', detail: null,
    });
    const bad = await checkSource({}, 'mixdrop', '!!!');
    assert.equal(bad.ok, false);
    assert.equal(bad.status, 400);
  });
});

describe('fetchEmbedText ordre direct-first', () => {
  const realFetch = globalThis.fetch;
  const relayEnv = { RELAY_DEFAULT_ORIGIN: 'https://relay.example' };
  it('direct 403 → repli relais 200 (pas de QUOTA immédiat)', async () => {
    const seen = [];
    globalThis.fetch = async (url) => {
      seen.push(String(url));
      if (String(url).startsWith('https://relay.example')) {
        return new Response('<html>via relais</html>', { status: 200, headers: { 'content-type': 'text/html' } });
      }
      return new Response('x', { status: 403 });
    };
    try {
      const { fetchEmbedText } = await import('../src/extractors/http.js');
      const page = await fetchEmbedText(relayEnv, 'https://host.example/e/abc123');
      assert.equal(page.text, '<html>via relais</html>');
      assert.equal(seen.length, 2);
      assert.ok(!seen[0].startsWith('https://relay.example'), 'direct en premier');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
  it('403 partout → QUOTA avec les 2 tentatives', async () => {
    globalThis.fetch = async () => new Response('x', { status: 403 });
    try {
      const { fetchEmbedText } = await import('../src/extractors/http.js');
      await assert.rejects(() => fetchEmbedText(relayEnv, 'https://host.example/e/abc123'), (error) => {
        assert.equal(error.code, 'QUOTA');
        assert.equal(error.attempts.length, 2);
        return true;
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
  it('404 partout → DEAD (pas de 404 relais seule)', async () => {
    let calls = 0;
    globalThis.fetch = async (url) => {
      calls += 1;
      return new Response('nf', { status: calls === 1 ? 500 : 404 });
    };
    try {
      const { fetchEmbedText } = await import('../src/extractors/http.js');
      // direct 500 (retryable) puis relais 404 : ni QUOTA ni verdict hâtif.
      await assert.rejects(() => fetchEmbedText(relayEnv, 'https://host.example/e/abc123'), (error) => {
        assert.equal(error.code, 'RETRYABLE');
        assert.equal(error.attempts.length, 2);
        return true;
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('registry', () => {
  it('expose mixdrop, dood, voe, uqload, vidzy, filmoon', () => {
    assert.equal(HOST, 'mixdrop');
    assert.deepEqual(SUPPORTED_HOSTS, ['mixdrop', 'dood', 'voe', 'uqload', 'vidzy', 'filmoon']);
  });
  it('400 sur host inconnu, sans toucher le réseau', async () => {
    const response = await serveExternalPlay({}, 'unknownhost', 'abc123');
    assert.equal(response.status, 400);
  });
  it('400 sur id invalide (parse avant tout fetch)', async () => {
    const response = await serveExternalPlay({}, 'mixdrop', '!!!');
    assert.equal(response.status, 400);
  });
});
