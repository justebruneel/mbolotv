// Erreurs typées des extracteurs tiers (Mixdrop, Doodstream, …).
// Le typage pilote le retry côté client ET le marquage de santé :
// - INVALID : entrée malformée (400, jamais de retry, jamais de re-sonde).
// - RETRYABLE : réseau/5xx/timeout (502, 1 retry max côté client).
// - QUOTA : 429/403 anti-bot du host (429, JAMAIS de retry — comme YouTube).
// - DEAD : 404/DMCA/fichier expiré (451, marquer la source morte, repli iframe).

export const ExtractorErrorCode = {
  INVALID: 'INVALID',
  RETRYABLE: 'RETRYABLE',
  QUOTA: 'QUOTA',
  DEAD: 'DEAD',
};

const CODE_STATUS = {
  [ExtractorErrorCode.INVALID]: 400,
  [ExtractorErrorCode.RETRYABLE]: 502,
  [ExtractorErrorCode.QUOTA]: 429,
  [ExtractorErrorCode.DEAD]: 451,
};

export class ExtractorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ExtractorError';
    this.code = code;
    this.status = CODE_STATUS[code] ?? 502;
  }
}

export function extractorError(code, message) {
  return new ExtractorError(code, message);
}

/** Ne jamais retry sur QUOTA/DEAD/INVALID (client + sondes). */
export function isRetryable(error) {
  return error instanceof ExtractorError && error.code === ExtractorErrorCode.RETRYABLE;
}
