import { ConfigService } from '@nestjs/config';

export type CorsResolution = { origins: string[] | boolean };

// Origine de production admise : https explicite, hôte complet, sans chemin
// ni joker. https:// seul — une origine http (hors localhost) ne doit jamais
// porter la session owner.
const PRODUCTION_ORIGIN_RE = /^https:\/\/[a-z0-9.-]+(:\d+)?$/i;

/**
 * Résout la configuration CORS à partir des variables d'environnement.
 *
 * Règles de sécurité :
 *  - En production, le mode `permissive` (toutes origines + credentials) est
 *    INTERDIT : l'API refuse de démarrer. Copier un .env.example en production
 *    ne peut plus exposer l'API.
 *  - En production stricte, `CORS_ALLOWED_ORIGINS` doit être non vide et ne
 *    contenir que des origines https concrètes : ni `*`, ni `null`, ni
 *    `localhost`, ni chemin. Toute violation fait échouer le démarrage.
 *  - Hors production, une liste vide en mode strict refuse CORS (erreur
 *    console) sans empêcher le démarrage — le comportement historique.
 */
export function resolveCors(config: ConfigService): CorsResolution {
  const isProd = (config.get<string>('NODE_ENV') ?? 'development').trim().toLowerCase() === 'production';
  const mode = (config.get<string>('CORS_MODE') ?? (isProd ? 'strict' : 'permissive')).trim().toLowerCase();
  if (mode === 'permissive') {
    if (isProd) {
      throw new Error('[cors] CORS_MODE=permissive interdit en production (origine reflétée + credentials). Passez CORS_MODE=strict et renseignez CORS_ALLOWED_ORIGINS.');
    }
    return { origins: true };
  }

  const origins = (config.get<string>('CORS_ALLOWED_ORIGINS', '') ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean);

  if (isProd) {
    if (origins.length === 0) {
      throw new Error('[cors] CORS_ALLOWED_ORIGINS est vide en production → démarrage refusé. Renseignez la liste des origines autorisées (ex: https://mbolotv-web.vercel.app).');
    }
    const invalid = origins.filter((origin) => !PRODUCTION_ORIGIN_RE.test(origin));
    if (invalid.length > 0) {
      throw new Error(`[cors] Origine(s) non admise(s) en production : ${invalid.join(', ')}. Exigé : https explicite, hôte complet, sans joker ni chemin.`);
    }
  }

  if (origins.length === 0) {
    // Refuser CORS plutôt que de retomber silencieusement sur un mode permissif :
    // une liste vide en mode strict est une erreur de configuration qui ne doit
    // pas devenir une faille. La console owner fonctionne en same-origin (proxy
    // reverse) : seul le navigateur cross-origin nécessite CORS_ALLOWED_ORIGINS.
    console.error(`[cors] CORS_MODE=strict mais CORS_ALLOWED_ORIGINS est vide → CORS refusé. Configurez CORS_ALLOWED_ORIGINS (ex: https://mbolo.tv).`);
    return { origins: false };
  }
  return { origins };
}
