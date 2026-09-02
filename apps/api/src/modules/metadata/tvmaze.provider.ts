import { ConfigService } from '@nestjs/config';
import { FanartProvider } from './fanart.provider';

/**
 * Enrichissement metadata via TVmaze (https://www.tvmaze.com/api) — gratuit, sans clé API.
 *
 * LIMITES DE L'API (documentées pour savoir où ça peut casser) :
 * - Rate limit : 20 requêtes/seconde par IP. Sans clé, pas de quota journalier
 *   officiel ; le service garde un délai de 120 ms entre les appels non cachés.
 * - Couverture : séries TV uniquement (pas de films). Les films et les
 *   téléfilms ne trouveront PAS de correspondance → fallback Fanart.tv
 *   (images seules) → sinon texte EPG brut sans image.
 * - `image.medium` = portrait ~210x295 (pas de backdrop/paysage) : l'UI doit
 *   être pensée pour un poster portrait. `summary` est du HTML brut (strip tags).
 * - Pas de bande-annonce (trailerUrl toujours null), pas de vote public fiable
 *   (rating.average souvent null sur les petites séries).
 * - Recherche : /search/shows retourne un score de fuzzy-match ; on exige une
 *   correspondance stricte du nom normalisé pour éviter les faux positifs EPG
 *   (ex : "Plus belle la vie" → résultats « Plus belle la vie, encore plus
 *   belle »). Sinon on prend le premier score élevé.
 */

export interface MetadataEnriched {
  source: 'tvmaze' | 'fanart';
  externalId: string | null;
  mediaType: 'tv';
  title: string;
  overview: string | null;
  posterUrl: string | null;
  backdropUrl: string | null;
  genres: string[];
  year: number | null;
  voteAverage: number | null;
  trailerUrl: string | null;
  seasonNumber?: number;
  episodeNumber?: number;
}

interface TvmazeShow {
  id: number;
  name: string;
  type?: string;
  language?: string;
  genres?: string[];
  premiered?: string | null;
  rating?: { average?: number | null };
  image?: { medium?: string; original?: string } | null;
  summary?: string | null;
  externals?: { tvrage?: number | null; thetvdb?: number | null; imdb?: string | null } | null;
}

const TVMAZE_BASE = 'https://api.tvmaze.com';

export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export class TvmazeProvider {
  private readonly fanart: FanartProvider;

  constructor(config: ConfigService) {
    this.fanart = new FanartProvider(config);
  }

  async search(title: string, year?: number): Promise<MetadataEnriched | null> {
    const clean = title.trim().slice(0, 80);
    if (!clean) return null;
    let shows: Array<{ score: number; show: TvmazeShow }> = [];
    try {
      const url = `${TVMAZE_BASE}/search/shows?q=${encodeURIComponent(clean)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return null;
      shows = (await res.json()) as Array<{ score: number; show: TvmazeShow }>;
    } catch {
      return null;
    }
    if (shows.length === 0) return null;

    const target = normalizeName(clean);
    // 1. Correspondance exacte du nom (éventuellement suivie de l'année pour
    //    les reboot/remakes) ; 2. à défaut, meilleur score de TVmaze (> 0.7).
    const exact = shows.find((s) => normalizeName(s.show.name) === target);
    const withYear = shows.find(
      (s) => normalizeName(s.show.name).startsWith(target) && year && s.show.premiered?.startsWith(String(year)),
    );
    const pick = withYear ?? exact ?? (shows[0].score > 0.7 ? shows[0] : undefined);
    if (!pick) return null;
    return this.mapShow(pick.show);
  }

  private async mapShow(show: TvmazeShow): Promise<MetadataEnriched> {
    let posterUrl: string | null = show.image?.original ?? show.image?.medium ?? null;
    let backdropUrl: string | null = null;
    // TVmaze peut renvoyer une fiche sans image : fallback Fanart.tv via le
    // TVDB ID (gratuit, images communautaires). Échec silencieux si indisponible.
    if (!posterUrl && show.externals?.thetvdb) {
      const fanart = await this.fanart.tvImages(show.externals.thetvdb);
      posterUrl = fanart?.poster ?? null;
      backdropUrl = fanart?.background ?? null;
    }
    return {
      source: posterUrl && !show.image ? 'fanart' : 'tvmaze',
      externalId: show.externals?.imdb ?? show.externals?.thetvdb?.toString() ?? show.id.toString(),
      mediaType: 'tv',
      title: show.name,
      overview: show.summary ? stripHtml(show.summary) : null,
      posterUrl,
      backdropUrl,
      genres: show.genres ?? [],
      year: show.premiered ? parseInt(show.premiered.slice(0, 4), 10) || null : null,
      voteAverage: show.rating?.average ?? null,
      trailerUrl: null,
    };
  }
}
