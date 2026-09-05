// Adapter French Stream (DLE) : fiche film → lecteurs.
// Découverte live (fiches newsid=15136768/15134662/15126436) :
// - la fiche HTML porte les métas (#film-data data-*, og:title, <title>) ;
// - les lecteurs viennent d'un GET JSON SANS auth :
//     {base}/engine/ajax/film_api.php?id=<newsid>
//   → { players: { premium|vidzy|uqload|dood|voe|filmoon|netu:
//         { default?, vostfr?, vfq?, vff? } }, meta: { affiche, affiche2,
//         trailer (ID YouTube), tagz, bkp } }.
// - certains embeds sont directs (fsvid.lol, vidzy.cc, uqload.vc), d'autres
//   passent par un wrapper 1-hop (kakaflix.lol, kokoflix.lol → redirect JS).
// Films uniquement : une page série (#serie-data) lève INVALID.
import { extractorError, ExtractorErrorCode } from '../extractors/errors.js';
import { fetchEmbedText } from '../extractors/http.js';
import { extractJsRedirect } from './wrappers.js';

export const SITE = 'frenchstream';

const NEWSID_PATTERN = /^\d{4,12}$/;
const VERSIONS = ['default', 'vostfr', 'vfq', 'vff'];

/** Domaines reconnus : french-stream.one/.club/…, base = origin de l'URL collée. */
export function matchUrl(url) {
  try {
    const parsed = new URL(String(url ?? '').trim());
    if (!/^https?:$/.test(parsed.protocol)) return null;
    if (!/french-?stream\./i.test(parsed.hostname)) return null;
    const newsid = parsed.searchParams.get('newsid');
    if (!newsid || !NEWSID_PATTERN.test(newsid)) return null;
    return { newsid, base: parsed.origin };
  } catch {
    return null;
  }
}

function metaContent(html, property) {
  const match = new RegExp(`<meta[^>]+property=["']${property}["'][^>]*>`, 'i').exec(String(html ?? ''));
  if (!match) return null;
  const content = /content=["']([^"']*)["']/i.exec(match[0]);
  return content?.[1]?.trim() || null;
}

function filmDataAttr(html, name) {
  const match = new RegExp(`data-${name}=["']([^"']*)["']`, 'i').exec(String(html ?? ''));
  return match?.[1]?.trim() || null;
}

function titleTag(html) {
  const match = /<title[^>]*>([^<]*)<\/title>/i.exec(String(html ?? ''));
  return match?.[1]?.trim() || null;
}

/** Titre : og:title d'abord (propre : « Dao »), sinon data-title, sinon <title> nettoyé. */
export function parseTitle(html) {
  const og = metaContent(html, 'og:title');
  if (og) return og;
  const data = filmDataAttr(html, 'title');
  if (data) return data;
  const tag = titleTag(html);
  if (tag) {
    return tag
      .replace(/\s+en streaming.*$/i, '')
      .replace(/^(film|série)\s+/i, '')
      .trim() || null;
  }
  return null;
}

/** Année : (2026) dans <title>, sinon lien date-de-sortie, sinon null. */
export function parseYear(html) {
  const source = String(html ?? '');
  const inTitle = /\((19|20)\d{2}\)/.exec(titleTag(html) ?? '');
  if (inTitle) return Number(inTitle[0].slice(1, 5));
  const xf = /xfname=date-de-sortie[^>]*>(\d{4})</.exec(source);
  if (xf) return Number(xf[1]);
  return null;
}

export function isSeriesPage(html) {
  const source = String(html ?? '');
  return source.includes('id="serie-data"') || source.includes('data-type="serie"');
}

function parseFilmApi(payload) {
  let data;
  try {
    data = JSON.parse(String(payload ?? ''));
  } catch {
    throw extractorError(ExtractorErrorCode.RETRYABLE, 'Réponse film_api illisible');
  }
  if (!data || typeof data !== 'object' || !data.players || typeof data.players !== 'object') {
    throw extractorError(ExtractorErrorCode.DEAD, 'Fiche sans lecteurs (retirée ou API changée)');
  }
  return data;
}

/**
 * Normalise les players film_api : [{ host, versions: [{ version, embedUrl }] }]
 * Dédupe les (host, url) identiques (ex. vff == default) en fusionnant les versions.
 */
export function normalizePlayers(filmApi) {
  const out = [];
  for (const [host, variants] of Object.entries(filmApi.players ?? {})) {
    if (!variants || typeof variants !== 'object') continue;
    for (const version of VERSIONS) {
      const url = typeof variants[version] === 'string' ? variants[version].trim() : '';
      if (!url || !/^https?:\/\//.test(url)) continue;
      const key = `${host}|${url}`;
      const existing = out.find((entry) => `${entry.host}|${entry.embedUrl}` === key);
      if (existing) {
        if (!existing.versions.includes(version)) existing.versions.push(version);
        continue;
      }
      out.push({ host: host.toLowerCase(), versions: [version], embedUrl: url });
    }
  }
  return out;
}

/** Suit 1 hop de wrapper (kakaflix/kokoflix → embed réel), null si direct. */
export async function resolveWrapper(env, embedUrl) {
  let hostname = '';
  try {
    hostname = new URL(embedUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!/kakaflix|kokoflix/.test(hostname)) return null;
  try {
    const page = await fetchEmbedText(env, embedUrl);
    return extractJsRedirect(page.text);
  } catch {
    return null;
  }
}

/**
 * Scrape une fiche film : HTML (métas) + film_api.php (lecteurs) en parallèle,
 * puis suivi 1-hop des wrappers. Lève INVALID (pas une fiche film),
 * DEAD (retirée/sans lecteurs) ou RETRYABLE (réseau).
 */
export async function scrapeFiche(env, ficheUrl) {
  const matched = matchUrl(ficheUrl);
  if (!matched) throw extractorError(ExtractorErrorCode.INVALID, 'URL de fiche French Stream invalide (attendu : …/index.php?newsid=<id>)');
  const { newsid, base } = matched;
  const [fiche, api] = await Promise.all([
    fetchEmbedText(env, `${base}/index.php?newsid=${newsid}`).catch((error) => {
      throw error instanceof Error ? error : extractorError(ExtractorErrorCode.RETRYABLE, 'Fiche injoignable');
    }),
    fetchEmbedText(env, `${base}/engine/ajax/film_api.php?id=${newsid}`).catch((error) => {
      throw error instanceof Error ? error : extractorError(ExtractorErrorCode.RETRYABLE, 'API lecteurs injoignable');
    }),
  ]);
  if (isSeriesPage(fiche.text)) {
    throw extractorError(ExtractorErrorCode.INVALID, 'Séries pas encore prises en charge (films uniquement)');
  }
  const filmApi = parseFilmApi(api.text);
  const title = parseTitle(fiche.text);
  if (!title) throw extractorError(ExtractorErrorCode.DEAD, 'Fiche sans titre (retirée ou structure changée)');
  const players = normalizePlayers(filmApi);
  if (players.length === 0) {
    throw extractorError(ExtractorErrorCode.DEAD, 'Fiche sans lecteurs (retirée ou API changée)');
  }
  // Suivi 1-hop des wrappers (embeds directs inchangés).
  const enriched = await Promise.all(
    players.map(async (player) => {
      const finalUrl = await resolveWrapper(env, player.embedUrl);
      return { ...player, wrapped: finalUrl !== null || /kakaflix|kokoflix/i.test(player.embedUrl), finalUrl };
    }),
  );
  // 2 wrappers d'un même host mènent souvent au même embed final
  // (ex. voe default/vfq) : fusionner sur (host, finalUrl ?? embedUrl).
  const merged = [];
  for (const player of enriched) {
    const key = `${player.host}|${player.finalUrl ?? player.embedUrl}`;
    const existing = merged.find((entry) => `${entry.host}|${entry.finalUrl ?? entry.embedUrl}` === key);
    if (existing) {
      for (const version of player.versions) {
        if (!existing.versions.includes(version)) existing.versions.push(version);
      }
      continue;
    }
    merged.push(player);
  }
  const meta = filmApi.meta ?? {};
  return {
    site: SITE,
    newsid,
    ficheUrl: `${base}/index.php?newsid=${newsid}`,
    title,
    year: parseYear(fiche.text),
    posterUrl: meta.affiche || filmDataAttr(fiche.text, 'affiche') || null,
    backdropUrl: meta.affiche2 || filmDataAttr(fiche.text, 'affiche2') || null,
    trailerYoutubeId: meta.trailer || filmDataAttr(fiche.text, 'trailer') || null,
    players: merged,
  };
}

export const _internal = { NEWSID_PATTERN, VERSIONS };
