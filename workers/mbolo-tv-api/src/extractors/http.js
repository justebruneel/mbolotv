// HTTP partagé des extracteurs : cascade relais → direct (miroir de
// ytplay.js), fingerprint navigateur desktop, timeouts calibrés FAI.
// Tout le trafic embed/handshake passe ici — un seul endroit à durcir
// (TLS, UA, relais) quand un host renforce son anti-bot.
import { resolveRelay } from '../relay.js';
import { ExtractorError, extractorError, ExtractorErrorCode } from './errors.js';

export const EMBED_TIMEOUT_MS = 10_000;
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
/**
 * Une tentative réseau horodatée, attachée aux erreurs (diagnostic prod :
 * on voit quel maillon casse — relais vs direct, statut vs timeout).
 */
function attempt(label, startedAt, status, error) {
  return { target: label, ms: Date.now() - startedAt, ...(status ? { status } : {}), ...(error ? { error: String(error).slice(0, 120) } : {}) };
}

export async function fetchEmbedText(env, url, { via = 'auto' } = {}) {
  const relayed = resolveRelay(env, url);
  // Direct d'abord (1 seul fetch dans le cas courant), relais en repli :
  // divise par ~2 le budget sous-requêtes du publish et la latence. Le relais
  // reste indispensable pour les hosts qui filtrent les IP Cloudflare.
  // via='relay' force le relais seul — utile quand un jeton est lié à l'IP
  // qui a chargé la page (Vidzy) : page ET probe doivent sortir par le même
  // chemin pour que le jeton reste valable.
  const targets = [];
  if (via === 'relay') {
    if (relayed.url === url) throw extractorError(ExtractorErrorCode.RETRYABLE, 'Relais non configuré pour cette URL');
    targets.push({ url: relayed.url, headers: relayed.headers, label: 'relais' });
  } else {
    targets.push({ url, headers: {}, label: 'direct' });
    if (relayed.url !== url) targets.push({ url: relayed.url, headers: relayed.headers, label: 'relais' });
  }
  const attempts = [];
  let quotaError = null;
  let deadError = null;
  let lastError = null;
  let sawRetryable = false;
  for (const target of targets) {
    const startedAt = Date.now();
    try {
      const response = await fetch(target.url, {
        headers: { ...documentHeaders(), ...target.headers },
        redirect: 'follow',
        signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
      });
      if (response.status === 429 || response.status === 403) {
        attempts.push(attempt(target.label, startedAt, response.status));
        try { await response.body?.cancel(); } catch {}
        // Anti-bot sur CE chemin seulement : on essaie l'autre avant de
        // conclure (un 403 relais n'interdit pas le direct, et inversement).
        quotaError ??= extractorError(ExtractorErrorCode.QUOTA, `Host distant anti-bot (${response.status})`);
        continue;
      }
      if (response.status === 404 || response.status === 410) {
        attempts.push(attempt(target.label, startedAt, response.status));
        try { await response.body?.cancel(); } catch {}
        deadError ??= extractorError(ExtractorErrorCode.DEAD, 'Fichier introuvable ou retiré (DMCA/expiré)');
        continue;
      }
      if (!response.ok) {
        attempts.push(attempt(target.label, startedAt, response.status));
        try { await response.body?.cancel(); } catch {}
        sawRetryable = true;
        lastError = extractorError(ExtractorErrorCode.RETRYABLE, `Host distant ${response.status}`);
        continue;
      }
      return { text: await response.text(), finalUrl: response.url || target.url };
    } catch (error) {
      if (error instanceof ExtractorError) throw error;
      attempts.push(attempt(target.label, startedAt, null, error instanceof Error ? error.message : error));
      sawRetryable = true;
      lastError = extractorError(ExtractorErrorCode.RETRYABLE, 'Host distant injoignable');
    }
  }
  // Verdict : DEAD seulement à l'unanimité (tout 404/410) — un signal
  // transitoire ou anti-bot quelque part interdit de condamner la source.
  // Chaîne complète attachée au verdict.
  const verdict = !sawRetryable && deadError && !quotaError
    ? deadError
    : (quotaError ?? lastError ?? extractorError(ExtractorErrorCode.RETRYABLE, 'Host distant injoignable'));
  throw withAttempts(verdict, attempts);
}

export function withAttempts(error, attempts) {
  error.attempts = (attempts ?? []).map((entry) => ({ ...entry }));
  return error;
}

/** Résumé lisible des tentatives pour les réponses API/console. */
export function attemptsSummary(error) {
  const attempts = error && Array.isArray(error.attempts) ? error.attempts : null;
  if (!attempts || attempts.length === 0) return null;
  return attempts
    .map((entry) => `${entry.target}: ${entry.status ? `HTTP ${entry.status}` : entry.error ?? '?'}${entry.ms != null ? ` (${entry.ms}ms)` : ''}`)
    .join('; ');
}

/**
 * Sonde un lien CDN direct : Range bytes=0-15 doit répondre 200/206 avec un
 * contenu vidéo. Le Referer du miroir est injecté (les CDN Mixdrop/Dood
 * répondent 403 sans lui). Utilisé avant de renvoyer l'URL au lecteur pour
 * ne jamais servir un lien mort.
 */
export async function probeDirectUrl(env, url, referer, attemptsOut, { via = 'auto' } = {}) {
  const relayed = resolveRelay(env, url);
  // Direct d'abord, relais en repli (même raison que fetchEmbedText).
  const targets = [];
  if (via === 'relay') {
    if (relayed.url === url) return false;
    targets.push({ url: relayed.url, headers: relayed.headers, label: 'relais' });
  } else {
    targets.push({ url, headers: {}, label: 'direct' });
    if (relayed.url !== url) targets.push({ url: relayed.url, headers: relayed.headers, label: 'relais' });
  }
  for (const target of targets) {
    const startedAt = Date.now();
    const note = (status, error) => {
      if (Array.isArray(attemptsOut)) attemptsOut.push(attempt(target.label, startedAt, status, error));
    };
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
        // Même règle que fetchEmbedText : un 403/429 sur UN chemin n'est pas
        // un verdict — l'autre chemin (relais résidentiel si le direct est
        // une IP datacenter bloquée, ou l'inverse) est essayé avant de
        // conclure « injoignable ».
        note(response.status);
        try { await response.body?.cancel(); } catch {}
        continue;
      }
      if (response.status !== 200 && response.status !== 206) {
        note(response.status);
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
      note(response.status, `content-type inattendu (${contentType || 'absent'})`);
    } catch (error) {
      note(null, error instanceof Error ? error.message : error);
      continue;
    }
  }
  return false;
}
