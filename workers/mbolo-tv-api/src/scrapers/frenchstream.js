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

/* ---------------------------------------------------------------------------
 * Détails façon Netflix (synopsis, genres, durée, réalisateur, acteurs, titre
 * original) : parseurs DÉFENSIFS — chaque champ tente plusieurs sources (liste
 * <li> libellée, data-*, meta og:description) et retombe sur null si absent :
 * l'UI masque ce qui manque, jamais de planter ni de texte parasite. Site non
 * interrogeable ici (anti-bot) : d'où le multi-sources et le repli systématique.
 * ------------------------------------------------------------------------- */

/** Décode les entités HTML courantes et nettoie le texte extrait. */
function cleanText(html) {
  return String(html ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;|&apos;|&rsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&laquo;|&raquo;/g, ' ')
    .replace(/&egrave;|&Egrave;/g, 'è')
    .replace(/&eacute;|&Eacute;/g, 'é')
    .replace(/&agrave;|&Agrave;/g, 'à')
    .replace(/&ccedil;|&Ccedil;/g, 'ç')
    .replace(/&atilde;|&tilde;|&ntilde;/g, ' ')
    .replace(/&#(\d+);/g, (_m, code) => {
      try { return String.fromCharCode(Number(code)); } catch { return ''; }
    })
    .replace(/\s+/g, ' ')
    .trim();
}

const MAX_FIELD_LENGTH = 400;
const MAX_SYNOPSIS_LENGTH = 1_500;

/** Ligne « Label : valeur » dans un <li> de la fiche (valeur = texte nu ou
 *  suite de liens séparés par des virgules). Bornée, null si introuvable. */
function labeledField(source, label) {
  const re = new RegExp(
    `<li[^>]*>[\\s\\S]{0,60}?${label}[\\s\\u00a0:]*([\\s\\S]{1,400}?)</li>`,
    'i',
  );
  const match = re.exec(source);
  if (!match) return null;
  const value = cleanText(match[1]).slice(0, MAX_FIELD_LENGTH);
  return value || null;
}

/** Synopsis : bloc #film-story / .story / .description, repli og:description. */
function parseSynopsis(source) {
  for (const selector of ['id="film-story"', 'id="story"', 'class="[^"]*\\bstory\\b[^"]*"', 'class="[^"]*\\bdescription\\b[^"]*"']) {
    const match = new RegExp(`<div[^>]+${selector}[^>]*>([\\s\\S]{1,4000}?)</div>`, 'i').exec(source);
    if (match) {
      const text = cleanText(match[1]).slice(0, MAX_SYNOPSIS_LENGTH);
      if (text.length >= 20) return text;
    }
  }
  const og = metaContent(source, 'og:description');
  if (og) {
    const text = cleanText(og).slice(0, MAX_SYNOPSIS_LENGTH);
    // og:description d'un film DLE commence parfois par le titre + année :
    // trop court ou redondant avec le <title> → inutilisable comme synopsis.
    if (text.length >= 40) return text;
  }
  return null;
}

/** Genres : ligne « Genre(s) : » (liens), repli data-genre, puis tagz de
 *  film_api (les tags DLE portent souvent les genres). Tableau max 6. */
function parseGenres(source, tagz) {
  const fromField = labeledField(source, 'Genres?');
  if (fromField) {
    const list = fromField.split(',').map((value) => value.trim()).filter(Boolean).slice(0, 6);
    if (list.length > 0) return list;
  }
  const data = filmDataAttr(source, 'genre');
  if (data) {
    const list = cleanText(data).split(',').map((value) => value.trim()).filter(Boolean).slice(0, 6);
    if (list.length > 0) return list;
  }
  if (typeof tagz === 'string' && tagz.trim()) {
    const list = cleanText(tagz).split(',').map((value) => value.trim()).filter(Boolean).slice(0, 6);
    if (list.length > 0) return list;
  }
  return null;
}

/** Détails Netflix-like : chaque champ null si non trouvé (UI masque). */
export function parseDetails(html, meta) {
  const source = String(html ?? '');
  const original = filmDataAttr(source, 'original')
    ?? labeledField(source, 'Titre\\s+original')
    ?? (typeof meta?.original === 'string' ? cleanText(meta.original) : null);
  return {
    synopsis: parseSynopsis(source),
    originalTitle: original ? original.slice(0, MAX_FIELD_LENGTH) : null,
    genres: parseGenres(source, meta?.tagz),
    duration: labeledField(source, 'Dur[ée]e') ?? filmDataAttr(source, 'duree'),
    director: labeledField(source, 'R[ée]alisateur') ?? filmDataAttr(source, 'realisateur'),
    cast: labeledField(source, 'Acteurs|Casting') ?? filmDataAttr(source, 'acteurs'),
  };
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
    ...parseDetails(fiche.text, meta),
    players: merged,
  };
}

export const _internal = { NEWSID_PATTERN, VERSIONS, parseDetails, cleanText };
