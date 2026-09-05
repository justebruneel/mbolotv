// Adapter DoodStream : page embed → pass_md5 → MP4 CDN signé.
// Protocole observé live (wrapper kokoflix/tokyo_go = player Dood officiel) :
//   GET {embed} → HTML avec `$.get('/pass_md5/<path>/<token>', …)`
//   GET {origin}/pass_md5/<path>/<token> (avec Referer) → préfixe CDN texte
//   direct = préfixe + aléatoire(10) + "?token=<token>&expiry=<now_ms>"
//   (cf. makePlay() du player). Probe Range avant de servir.
// Notes :
// - les tokens semblent à usage unique / fenêtre courte : résolution AU CLIC,
//   jamais de pré-chargement ; le lecteur re-résout via refetch si expiré.
// - les wrappers kakaflix/kokoflix SONT des pages Dood (même player) : toute
//   URL https://… pleine est acceptée comme embed, pas seulement dood.*.
// - protections page (Turnstile, FingerprintJS, DisableDevtool, sandbox-detect)
//   ne concernent que le navigateur : le handshake pass_md5 passe en HTTP pur.
import { ExtractorError, extractorError, ExtractorErrorCode } from './errors.js';
import { fetchEmbedText, probeDirectUrl } from './http.js';

export const HOST = 'dood';

const CODE_PATTERN = /^[A-Za-z0-9]{4,32}$/;
const PASS_MD5_PATTERN = /\/pass_md5\/[^\s'"<>]+/;
const DEAD_MARKERS = /video unavailable|not found|file (was )?deleted|dmca|has been removed/i;

// Miroirs Dood connus (tournants) — utilisés UNIQUEMENT pour un code nu ;
// en pratique les URLs viennent des fiches (kokoflix/kakaflix/dood.*) en absolu.
const MIRROR_DEFAULTS = ['https://dood.to', 'https://dood.watch', 'https://dood.li', 'https://dood.la'];

export function mirrorsFromEnv(env) {
  const raw = String(env?.DOOD_MIRRORS ?? '').trim();
  if (!raw) return [...MIRROR_DEFAULTS];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.map((entry) => String(entry).trim().replace(/\/+$/, '')).filter((entry) => /^https?:\/\//.test(entry));
    }
  } catch { /* repli CSV */ }
  const list = raw
    .split(',')
    .map((entry) => entry.trim().replace(/\/+$/, ''))
    .filter((entry) => /^https?:\/\//.test(entry));
  return list.length > 0 ? list : [...MIRROR_DEFAULTS];
}

/**
 * Accepte : URL embed complète (dood.* ou wrapper kakaflix/kokoflix…),
 * chemin /d/|/e/{code}, ou code nu. Lève INVALID sinon.
 */
export function parse(input) {
  const value = String(input ?? '').trim();
  if (!value) throw extractorError(ExtractorErrorCode.INVALID, 'Identifiant DoodStream manquant');
  // Schéma présent mais non-http(s) : refuser plutôt que d'extraire un
  // faux code du chemin (ex. ftp://…/e/abcd).
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !/^https?:\/\//i.test(value)) {
    throw extractorError(ExtractorErrorCode.INVALID, 'URL DoodStream invalide');
  }
  if (/^https?:\/\//i.test(value)) {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw extractorError(ExtractorErrorCode.INVALID, 'URL DoodStream invalide');
    }
    return { embedUrl: `${parsed.origin}${parsed.pathname}${parsed.search}` };
  }
  const fromPath = /\/(?:d|e)\/([A-Za-z0-9]{4,32})/.exec(value);
  const code = fromPath?.[1] ?? value;
  if (!CODE_PATTERN.test(code)) throw extractorError(ExtractorErrorCode.INVALID, 'Identifiant DoodStream invalide');
  return { code };
}

function randomSuffix(length = 10) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join('');
}

/** Extrait le chemin /pass_md5/… de la page embed, null si absent. */
export function extractPassMd5(html) {
  const match = PASS_MD5_PATTERN.exec(String(html ?? ''));
  return match ? match[0] : null;
}

/**
 * Résout un embed en lien CDN direct vérifié (probe Range).
 * Entrée : URL complète (cas fiches) ou code nu (miroirs DOOD_MIRRORS).
 */
export async function resolve(env, ref) {
  const parsed = typeof ref === 'string' ? parse(ref) : parse(ref?.embedUrl ?? ref?.url ?? ref?.code ?? ref?.id ?? '');
  const candidates = parsed.embedUrl
    ? [parsed.embedUrl]
    : mirrorsFromEnv(env).map((mirror) => `${mirror.replace(/\/+$/, '')}/e/${parsed.code}`);
  let lastError = null;
  for (const embedUrl of candidates) {
    let origin = '';
    try {
      origin = `${new URL(embedUrl).origin}/`;
    } catch {
      lastError = extractorError(ExtractorErrorCode.INVALID, 'URL DoodStream invalide');
      continue;
    }
    let page;
    try {
      page = await fetchEmbedText(env, embedUrl);
    } catch (error) {
      lastError = error;
      if (error instanceof ExtractorError && error.code !== ExtractorErrorCode.RETRYABLE && error.code !== ExtractorErrorCode.DEAD) throw error;
      continue;
    }
    if (DEAD_MARKERS.test(page.text)) {
      lastError = extractorError(ExtractorErrorCode.DEAD, 'Fichier DoodStream retiré ou inexistant');
      continue;
    }
    const passMd5 = extractPassMd5(page.text);
    if (!passMd5) {
      lastError = extractorError(ExtractorErrorCode.DEAD, 'Player DoodStream sans handshake (fichier retiré ou player changé)');
      continue;
    }
    const token = passMd5.split('/').filter(Boolean).pop() ?? '';
    let prefix;
    try {
      const handshake = await fetchEmbedText(env, `${origin.replace(/\/+$/, '')}${passMd5}`);
      prefix = handshake.text.trim();
    } catch (error) {
      lastError = error;
      continue;
    }
    if (!prefix || prefix === 'RELOAD' || !/^https?:\/\//.test(prefix)) {
      // RELOAD = token à usage unique déjà consommé → re-résoudre au prochain clic.
      lastError = extractorError(ExtractorErrorCode.RETRYABLE, 'Handshake DoodStream rejeté (relecture)');
      continue;
    }
    const direct = `${prefix}${randomSuffix()}?token=${token}&expiry=${Date.now()}`;
    if (!/^https:\/\//.test(direct)) {
      lastError = extractorError(ExtractorErrorCode.DEAD, 'URL CDN DoodStream inattendue');
      continue;
    }
    const ok = await probeDirectUrl(env, direct, origin);
    if (!ok) {
      lastError = extractorError(ExtractorErrorCode.RETRYABLE, 'CDN DoodStream injoignable (vérification)');
      continue;
    }
    return { urls: [direct], referer: origin, title: extractDoodTitle(page.text) };
  }
  throw lastError ?? extractorError(ExtractorErrorCode.RETRYABLE, 'DoodStream injoignable');
}

function extractDoodTitle(html) {
  const match = /<title[^>]*>([^<]*)<\/title>/i.exec(String(html ?? ''));
  if (!match) return null;
  return match[1].replace(/\s*-\s*DoodStream\s*$/i, '').trim() || null;
}

export const _internal = { MIRROR_DEFAULTS, CODE_PATTERN, PASS_MD5_PATTERN };
