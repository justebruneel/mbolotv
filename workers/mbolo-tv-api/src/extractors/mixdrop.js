// Adapter Mixdrop : page /e/{id} → MDCore.wurl → MP4 signé mxcontent.net.
// Le lien signé (?s=&e=&_t=) expire : résolution AU CLIC uniquement, jamais
// en masse, cache edge court (voir index.js). La lecture passe par le proxy
// vidéo signé avec Referer injecté (le CDN répond 403 sans le Referer du miroir).
import { ExtractorError, extractorError, ExtractorErrorCode } from './errors.js';
import { fetchEmbedText, probeDirectUrl, withAttempts } from './http.js';
import { absolutizeCdnUrl, extractTitle, extractWurl } from './unpack.js';

export const HOST = 'mixdrop';

// Miroirs canoniques connus. L'env MIXDROP_MIRRORS (JSON ["…"] ou liste
// "https://a,https://b") surcharge SANS redéploiement quand les domaines
// tournent — le premier qui répond gagne.
// miixdrop.top observé comme canonique en live (les autres y redirigent) —
// en tête pour économiser un saut. Surchargeable via MIXDROP_MIRRORS.
const MIRROR_DEFAULTS = ['https://miixdrop.top', 'https://miixdrop.net', 'https://mixdrop.ag', 'https://mixdrop.co'];

const ID_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;

export function mirrorsFromEnv(env) {
  const raw = String(env?.MIXDROP_MIRRORS ?? '').trim();
  if (!raw) return [...MIRROR_DEFAULTS];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.map((entry) => String(entry).trim().replace(/\/+$/, '')).filter((entry) => /^https?:\/\//.test(entry));
    }
  } catch {
    // Pas du JSON : tenter la liste séparée par virgules.
  }
  const list = raw
    .split(',')
    .map((entry) => entry.trim().replace(/\/+$/, ''))
    .filter((entry) => /^https?:\/\//.test(entry));
  return list.length > 0 ? list : [...MIRROR_DEFAULTS];
}

/**
 * Accepte un id nu (el09xempuzkxz4), une URL embed (/e/{id}) ou fichier
 * (/f/{id}). Lève INVALID si rien d'exploitable.
 */
export function parse(input) {
  const value = String(input ?? '').trim();
  if (!value) throw extractorError(ExtractorErrorCode.INVALID, 'Identifiant Mixdrop manquant');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !/^https?:\/\//i.test(value)) {
    throw extractorError(ExtractorErrorCode.INVALID, 'URL Mixdrop invalide');
  }
  const embedded = /\/(?:e|f)\/([A-Za-z0-9_-]{4,64})/.exec(value);
  const id = embedded?.[1] ?? value;
  if (!ID_PATTERN.test(id)) throw extractorError(ExtractorErrorCode.INVALID, 'Identifiant Mixdrop invalide');
  return { id };
}

/**
 * Résout un id en lien CDN direct vérifié (probe Range).
 * Essaie les miroirs dans l'ordre : un miroir désynchronisé (404, page sans
 * wurl) ne condamne pas les autres — seul DEAD sur TOUS les miroirs vaut
 * fichier retiré. QUOTA/INVALID sortent immédiatement (inutile de marteler).
 */
export async function resolve(env, ref) {
  const { id } = typeof ref === 'string' ? parse(ref) : parse(ref?.id ?? ref?.input ?? '');
  const mirrors = mirrorsFromEnv(env);
  let lastError = null;
  for (const mirror of mirrors) {
    const origin = mirror.replace(/\/+$/, '');
    let page;
    try {
      page = await fetchEmbedText(env, `${origin}/e/${id}`);
    } catch (error) {
      lastError = error;
      if (error instanceof ExtractorError && error.code !== ExtractorErrorCode.RETRYABLE && error.code !== ExtractorErrorCode.DEAD) throw error;
      continue;
    }
    const wurl = extractWurl(page.text);
    if (!wurl) {
      lastError = extractorError(ExtractorErrorCode.DEAD, 'Player Mixdrop sans URL vidéo (fichier retiré ou player changé)');
      continue;
    }
    const direct = absolutizeCdnUrl(wurl);
    if (!/^https:\/\/[^/]*mxcontent\.net\//.test(direct)) {
      // Garde anti-exfiltration : le CDN Mixdrop est le seul hôte attendu.
      lastError = extractorError(ExtractorErrorCode.DEAD, 'URL CDN Mixdrop inattendue');
      continue;
    }
    // Referer = origine FINALE (après redirections : mixdrop.ag → miixdrop.net
    // par ex.) — c'est elle que le CDN vérifie, pas le miroir demandé.
    let referer = `${origin}/`;
    try {
      if (page.finalUrl) referer = `${new URL(page.finalUrl).origin}/`;
    } catch {
      // finalUrl inattendue : garder le miroir demandé.
    }
    const probeAttempts = [];
    const ok = await probeDirectUrl(env, direct, referer, probeAttempts);
    if (!ok) {
      lastError = withAttempts(extractorError(ExtractorErrorCode.RETRYABLE, 'CDN Mixdrop injoignable (vérification)'), probeAttempts);
      continue;
    }
    return { urls: [direct], referer, title: extractTitle(page.text) };
  }
  throw lastError ?? extractorError(ExtractorErrorCode.RETRYABLE, 'Mixdrop injoignable');
}

export const _internal = { MIRROR_DEFAULTS, ID_PATTERN };
