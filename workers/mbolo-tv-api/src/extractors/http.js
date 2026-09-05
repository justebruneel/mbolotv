// HTTP partagé des extracteurs : cascade relais → direct (miroir de
// ytplay.js), fingerprint navigateur desktop, timeouts calibrés FAI.
// Tout le trafic embed/handshake passe ici — un seul endroit à durcir
// (TLS, UA, relais) quand un host renforce son anti-bot.
import { resolveRelay } from '../relay.js';
import { ExtractorError, extractorError, ExtractorErrorCode } from './errors.js';

export const EMBED_TIMEOUT_MS = 15_000;
export const PROBE_TIMEOUT_MS = 10_000;

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function documentHeaders(referer) {
  return {
    'user-agent': CHROME_UA,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'accept-language': 'fr-FR,fr;q=0.9,en;q=0.8',
    'upgrade-insecure-requests': '1',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    ...(referer ? { referer } : {}),
  };
}

/**
 * Récupère une page embed en essayant le relais résidentiel d'abord
 * (IP résidentielle = moins de bot-check que les IP datacenter),
 * puis en direct. Lève ExtractorError typée.
 */
export async function fetchEmbedText(env, url) {
  const relayed = resolveRelay(env, url);
  const targets = [];
  if (relayed.url !== url) targets.push({ url: relayed.url, headers: relayed.headers, label: 'relais' });
  targets.push({ url, headers: {}, label: 'direct' });
  let lastError = null;
  for (const target of targets) {
    try {
      const response = await fetch(target.url, {
        headers: { ...documentHeaders(), ...target.headers },
        redirect: 'follow',
        signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
      });
      if (response.status === 429 || response.status === 403) {
        throw extractorError(ExtractorErrorCode.QUOTA, `Host distant anti-bot (${response.status})`);
      }
      if (response.status === 404 || response.status === 410) {
        throw extractorError(ExtractorErrorCode.DEAD, 'Fichier introuvable ou retiré (DMCA/expiré)');
      }
      if (!response.ok) {
        lastError = extractorError(ExtractorErrorCode.RETRYABLE, `Host distant ${response.status}`);
        continue;
      }
      return { text: await response.text(), finalUrl: response.url || target.url };
    } catch (error) {
      if (error instanceof ExtractorError && error.code !== ExtractorErrorCode.RETRYABLE) throw error;
      lastError = error instanceof ExtractorError ? error : extractorError(ExtractorErrorCode.RETRYABLE, 'Host distant injoignable');
    }
  }
  throw lastError ?? extractorError(ExtractorErrorCode.RETRYABLE, 'Host distant injoignable');
}

/**
 * Sonde un lien CDN direct : Range bytes=0-15 doit répondre 200/206 avec un
 * contenu vidéo. Le Referer du miroir est injecté (les CDN Mixdrop/Dood
 * répondent 403 sans lui). Utilisé avant de renvoyer l'URL au lecteur pour
 * ne jamais servir un lien mort.
 */
export async function probeDirectUrl(env, url, referer) {
  const relayed = resolveRelay(env, url);
  const targets = [];
  if (relayed.url !== url) targets.push({ url: relayed.url, headers: relayed.headers });
  targets.push({ url, headers: {} });
  for (const target of targets) {
    try {
      const response = await fetch(target.url, {
        headers: {
          'user-agent': CHROME_UA,
          accept: '*/*',
          range: 'bytes=0-15',
          ...(referer ? { referer } : {}),
          ...target.headers,
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (response.status === 429 || response.status === 403) {
        try { await response.body?.cancel(); } catch {}
        return false;
      }
      if (response.status !== 200 && response.status !== 206) {
        try { await response.body?.cancel(); } catch {}
        continue;
      }
      const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
      const hasContentRange = response.headers.has('content-range');
      // Annuler le corps SANS le lire : si le CDN ignore le Range et répond
      // 200 avec le fichier entier, un arrayBuffer() chargerait des Go en
      // mémoire d'isolate. Seuls les en-têtes nous intéressent.
      try { await response.body?.cancel(); } catch {}
      // 206 + content-range = un vrai serveur de fichier répond au Range,
      // même sans content-type vidéo explicite.
      if (/video\//.test(contentType) || /octet-stream/.test(contentType)) return true;
      // Playlists HLS (Voe…) : content-type mpegurl, corps texte court.
      if (/mpegurl/.test(contentType)) return true;
      if (response.status === 206 && hasContentRange) return true;
    } catch {
      continue;
    }
  }
  return false;
}
