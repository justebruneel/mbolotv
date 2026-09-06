// Adapter Voe : page /e/{id} → JSON obfusqué → URL HLS directe.
// Algorithme reconstitué du loader officiel (loader.*.js) :
//   1. ROT13 de la chaîne <script type="application/json">["…"]
//   2. Remplacer les 7 séparateurs (@$ ^^ ~@ %? *~ !! #&) par _
//   3. Supprimer les _  → base64 pur
//   4. atob → charCode - 3 → reverse → atob → JSON.parse
//   → { file (URL m3u8), title, image, … } monté dans jwplayer.
// La page porte aussi un leurre (var source = Big Buck Bunny) : ignoré.
import { ExtractorError, extractorError, ExtractorErrorCode } from './errors.js';
import { fetchEmbedText, probeDirectUrl, withAttempts } from './http.js';

export const HOST = 'voe';

const CODE_PATTERN = /^[A-Za-z0-9]{8,16}$/;
const SEPARATORS = ['@$', '^^', '~@', '%?', '*~', '!!', '#&'];

const MIRROR_DEFAULTS = ['https://voe.sx'];

export function mirrorsFromEnv(env) {
  const raw = String(env?.VOE_MIRRORS ?? '').trim();
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
 * Accepte : URL embed complète (miroir voe quelconque : voe.sx,
 * eugenemakedraw.com, …), chemin /e/{code}, ou code nu. Lève INVALID sinon.
 */
export function parse(input) {
  const value = String(input ?? '').trim();
  if (!value) throw extractorError(ExtractorErrorCode.INVALID, 'Identifiant Voe manquant');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !/^https?:\/\//i.test(value)) {
    throw extractorError(ExtractorErrorCode.INVALID, 'URL Voe invalide');
  }
  if (/^https?:\/\//i.test(value)) {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw extractorError(ExtractorErrorCode.INVALID, 'URL Voe invalide');
    }
    return { embedUrl: `${parsed.origin}${parsed.pathname}${parsed.search}` };
  }
  const fromPath = /\/e\/([A-Za-z0-9]{8,16})/.exec(value);
  const code = fromPath?.[1] ?? value;
  if (!CODE_PATTERN.test(code)) throw extractorError(ExtractorErrorCode.INVALID, 'Identifiant Voe invalide');
  return { code };
}

export function rot13(source) {
  return String(source ?? '').replace(/[A-Za-z]/g, (char) => {
    const base = char <= 'Z' ? 65 : 97;
    return String.fromCharCode(((char.charCodeAt(0) - base + 13) % 26) + base);
  });
}

/** Extrait le payload ["…"] du script application/json, null si absent. */
export function extractPayload(html) {
  const blocks = String(html ?? '').match(/<script[^>]+type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi) ?? [];
  for (const block of blocks) {
    const inner = /<script[^>]*>([\s\S]*?)<\/script>/i.exec(block);
    if (!inner) continue;
    try {
      const parsed = JSON.parse(inner[1]);
      if (Array.isArray(parsed) && typeof parsed[0] === 'string' && parsed[0].length > 0) return parsed[0];
    } catch { /* bloc JSON non-std : suivant */ }
  }
  return null;
}

/**
 * Décode le payload Voe en objet jwplayer. Clés vidéo observées live :
 * `source` (master HLS .urlset/master.m3u8 — préféré : adaptatif + réécriture
 * proxy), `file`, puis `direct_access_url` (MP4 téléchargement). Lève DEAD
 * si illisible.
 */
export function decodePayload(payload) {
  try {
    let step = rot13(payload);
    for (const separator of SEPARATORS) step = step.split(separator).join('_');
    step = step.split('_').join('');
    const once = atob(step);
    const shifted = [...once].map((char) => String.fromCharCode(char.charCodeAt(0) - 3)).join('');
    const reversed = [...shifted].reverse().join('');
    const decoded = JSON.parse(atob(reversed));
    if (!decoded || typeof decoded !== 'object') throw new Error('JSON invalide');
    const file = [decoded.source, decoded.file, decoded.direct_access_url].find(
      (entry) => typeof entry === 'string' && /^https?:\/\//.test(entry),
    );
    if (!file) throw new Error('JSON sans URL vidéo');
    return { ...decoded, file };
  } catch {
    throw extractorError(ExtractorErrorCode.DEAD, 'Player Voe illisible (fichier retiré ou chiffrement changé)');
  }
}

/**
 * Résout un embed en URL HLS directe vérifiée (probe).
 * Entrée : URL complète (cas fiches) ou code nu (miroirs VOE_MIRRORS).
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
      lastError = extractorError(ExtractorErrorCode.INVALID, 'URL Voe invalide');
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
    const payload = extractPayload(page.text);
    if (!payload) {
      lastError = extractorError(ExtractorErrorCode.DEAD, 'Page Voe sans source (fichier retiré ou page changée)');
      continue;
    }
    let decoded;
    try {
      decoded = decodePayload(payload);
    } catch (error) {
      lastError = error;
      continue;
    }
    const direct = String(decoded.file ?? '').trim();
    if (!/^https?:\/\//.test(direct)) {
      lastError = extractorError(ExtractorErrorCode.DEAD, 'URL vidéo Voe inattendue');
      continue;
    }
    const probeAttempts = [];
    const ok = await probeDirectUrl(env, direct, origin, probeAttempts);
    if (!ok) {
      lastError = withAttempts(extractorError(ExtractorErrorCode.RETRYABLE, 'CDN Voe injoignable (vérification)'), probeAttempts);
      continue;
    }
    return {
      urls: [direct],
      referer: origin,
      title: typeof decoded.title === 'string' && decoded.title ? decoded.title : null,
    };
  }
  throw lastError ?? extractorError(ExtractorErrorCode.RETRYABLE, 'Voe injoignable');
}

export const _internal = { MIRROR_DEFAULTS, CODE_PATTERN, SEPARATORS };
