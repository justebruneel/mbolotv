// Tests unitaires du scraper French Stream (fonctions pures, sans réseau).
// Lancer : node --test workers/mbolo-tv-api/test/scrapers.test.mjs
// La validation live se fait via scripts/probe-fiche.mjs (manuel).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ExtractorError } from '../src/extractors/errors.js';
import {
  SITE,
  isSeriesPage,
  matchUrl,
  normalizePlayers,
  parseTitle,
  parseYear,
} from '../src/scrapers/frenchstream.js';
import { extractJsRedirect } from '../src/scrapers/wrappers.js';
import { SUPPORTED_FICHE_SITES, serveFichePreview } from '../src/scrapers/index.js';

const FICHE_HTML = `<html><head><title>Film Dao (2026) en streaming complet</title>
<meta property="og:title" content="Dao">
</head><body><div id="film-data" data-newsid="15136768" data-title="Dao"
data-affiche="https://image.tmdb.org/t/p/w300/abc.jpg"></div>
<h1 id="s-title">Dao <span class="tag release_date"> - <a href="/index.php?do=xfsearch&xfname=date-de-sortie&xf=2026">2026</a></span></h1>
</body></html>`;

const FILM_API = JSON.stringify({
  players: {
    premium: { default: 'https://fsvid.lol/embed-a.html' },
    voe: { default: 'https://kakaflix.lol/voe3/newPlayer.php?id=uuid-1', vfq: 'https://kakaflix.lol/voe3/newPlayer.php?id=uuid-1' },
    vidzy: { default: 'https://vidzy.cc/embed-b.html', vff: 'https://vidzy.cc/embed-b.html' },
  },
  meta: { affiche: 'https://image.tmdb.org/t/p/w300/abc.jpg', trailer: 'b9wVcI2Guow' },
});

describe('matchUrl', () => {
  it('reconnaît les fiches french-stream.* avec newsid', () => {
    assert.deepEqual(matchUrl('https://french-stream.one/index.php?newsid=15136768'), {
      newsid: '15136768',
      base: 'https://french-stream.one',
    });
    assert.deepEqual(matchUrl('https://french-stream.club/index.php?newsid=4242&foo=1'), {
      newsid: '4242',
      base: 'https://french-stream.club',
    });
  });
  it('rejette hors-site, sans newsid, newsid invalide', () => {
    assert.equal(matchUrl('https://example.com/index.php?newsid=15136768'), null);
    assert.equal(matchUrl('https://french-stream.one/films/'), null);
    assert.equal(matchUrl('https://french-stream.one/index.php?newsid=abc'), null);
    assert.equal(matchUrl('not a url'), null);
  });
});

describe('parse meta fiche', () => {
  it('titre og:title, année (2026) du <title>', () => {
    assert.equal(parseTitle(FICHE_HTML), 'Dao');
    assert.equal(parseYear(FICHE_HTML), 2026);
  });
  it('repli data-title puis <title> nettoyé', () => {
    assert.equal(parseTitle('<div data-title="Dune 2"></div>'), 'Dune 2');
    assert.equal(parseTitle('<title>Film Dune (2024) en streaming complet</title>'), 'Dune (2024)');
  });
  it('détecte les pages séries (refusées)', () => {
    assert.equal(isSeriesPage('<div id="serie-data"></div>'), true);
    assert.equal(isSeriesPage(FICHE_HTML), false);
  });
});

describe('normalizePlayers', () => {
  it('fusionne les versions identiques (vff == default)', () => {
    const players = normalizePlayers(JSON.parse(FILM_API));
    assert.equal(players.length, 3);
    const vidzy = players.find((entry) => entry.host === 'vidzy');
    assert.deepEqual(vidzy.versions, ['default', 'vff']);
    const voe = players.find((entry) => entry.host === 'voe');
    assert.deepEqual(voe.versions, ['default', 'vfq']);
  });
  it('ignore les variants vides ou non-URL', () => {
    const players = normalizePlayers({ players: { dood: { default: '', vfq: 'notaurl', vostfr: 'https://x.example/e/1' } } });
    assert.equal(players.length, 1);
    assert.deepEqual(players[0].versions, ['vostfr']);
  });
});

describe('wrappers', () => {
  it('extrait le redirect JS statique (kakaflix → voe)', () => {
    assert.equal(
      extractJsRedirect(`<script>window.location.href = 'https://eugenemakedraw.com/e/fah90cksg9ep';</script>`),
      'https://eugenemakedraw.com/e/fah90cksg9ep',
    );
  });
  it('null sans redirect (embed direct)', () => {
    assert.equal(extractJsRedirect('<html><body>player</body></html>'), null);
  });
});

describe('registry', () => {
  it('expose frenchstream', () => {
    assert.equal(SITE, 'frenchstream');
    assert.deepEqual(SUPPORTED_FICHE_SITES, ['frenchstream']);
  });
  it('400 sur site inconnu, sans réseau', async () => {
    const response = await serveFichePreview({}, 'https://example.com/film/1');
    assert.equal(response.status, 400);
  });
  it('400 sur URL invalide', async () => {
    const response = await serveFichePreview({}, '!!!');
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.message, /non pris en charge/);
  });
  it('INVALID ne fuit pas de stack (message seul)', async () => {
    const response = await serveFichePreview({}, 'https://french-stream.one/index.php?newsid=abc');
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.ok(typeof body.message === 'string' && !('stack' in body));
    void ExtractorError;
  });
});
