import { ConfigService } from '@nestjs/config';

/**
 * Fanart.tv (https://fanart.tv) — secours image quand TVmaze ne renvoie pas
 * d'image pour une série. Clé API gratuite : https://fanart.tv/get-an-api-key/
 *
 * LIMITES DE L'API (documentées pour savoir où ça peut casser) :
 * - Clé requise (FANART_API_KEY). Sans clé → désactivé silencieusement.
 * - Quota : généreux (usage personnel gratuit, pas de limite stricte publiée ;
 *   throttling soft en cas d'abus). Appelé UNIQUEMENT en fallback TVmaze sans
 *   image, donc très peu sollicité.
 * - Couverture : indexée par TVDB ID (TVmaze expose show.externals.thetvdb).
 *   Les séries absentes de TVDB n'auront pas d'image de secours.
 * - tvposter : affiches portrait ; showbackground : paysages 1920x1080 (notre
 *   équivalent "backdrop", ce que TVmaze ne fournit pas).
 */

const FANART_BASE = 'https://webservice.fanart.tv/v3';

export class FanartProvider {
  private readonly apiKey: string | null;

  constructor(config: ConfigService) {
    this.apiKey = config.get<string>('FANART_API_KEY') ?? null;
  }

  isEnabled(): boolean {
    return Boolean(this.apiKey);
  }

  async tvImages(tvdbId: number): Promise<{ poster: string | null; background: string | null } | null> {
    if (!this.apiKey || !Number.isFinite(tvdbId)) return null;
    try {
      const res = await fetch(`${FANART_BASE}/tv/${tvdbId}?api_key=${this.apiKey}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as {
        tvposter?: Array<{ url: string; likes?: number }>;
        showbackground?: Array<{ url: string; likes?: number }>;
      };
      // Tri par likes (popularité communautaire) puis premier élément.
      const posters = (data.tvposter ?? []).slice().sort((a, b) => (b.likes ?? 0) - (a.likes ?? 0));
      const backgrounds = (data.showbackground ?? []).slice().sort((a, b) => (b.likes ?? 0) - (a.likes ?? 0));
      return {
        poster: posters[0]?.url ?? null,
        background: backgrounds[0]?.url ?? null,
      };
    } catch {
      return null;
    }
  }
}
