import { ConfigService } from '@nestjs/config';

export interface TmdbEnriched {
  tmdbId: number;
  mediaType: 'movie' | 'tv';
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

const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';
const CACHE_TTL_DAYS = 30;

export class TmdbProvider {
  private readonly apiKey: string | null;
  private readonly readToken: string | null;
  private readonly enabled: boolean;

  constructor(private readonly config: ConfigService) {
    this.apiKey = config.get<string>('TMDB_API_KEY') ?? config.get<string>('TMDB_API_TOKEN') ?? null;
    this.readToken = config.get<string>('TMDB_READ_TOKEN') ?? config.get<string>('TMDB_BEARER_TOKEN') ?? null;
    this.enabled = Boolean(this.apiKey || this.readToken);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  private get headers(): Record<string, string> {
    if (this.readToken) return { Authorization: `Bearer ${this.readToken}`, accept: 'application/json' };
    return { accept: 'application/json' };
  }

  private buildUrl(path: string, params: Record<string, string | number | undefined>): string {
    const url = new URL(`https://api.themoviedb.org/3${path}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
    if (this.apiKey && !this.readToken) url.searchParams.set('api_key', this.apiKey);
    return url.toString();
  }

  async search(title: string, year?: number): Promise<TmdbEnriched | null> {
    if (!this.enabled || !title.trim()) return null;
    const clean = title.trim().slice(0, 80);
    // 1. search multi
    const searchUrl = this.buildUrl('/search/multi', { query: clean, language: 'fr-FR', include_adult: 'false' });
    try {
      const res = await fetch(searchUrl, { headers: this.headers });
      if (!res.ok) return null;
      const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
      const candidates = (data.results ?? []).filter((r) => r.media_type === 'movie' || r.media_type === 'tv').slice(0, 5) as Array<{
        id: number;
        media_type: 'movie' | 'tv';
        title?: string;
        name?: string;
        poster_path: string | null;
        backdrop_path: string | null;
        overview: string | null;
        genre_ids?: number[];
        release_date?: string;
        first_air_date?: string;
        vote_average?: number;
      }>;
      if (candidates.length === 0) return null;
      // Privilégie correspondance d'année si fournie
      let best = candidates[0];
      if (year) {
        const match = candidates.find((c) => {
          const d = c.media_type === 'movie' ? c.release_date : c.first_air_date;
          return d?.startsWith(String(year));
        });
        if (match) best = match;
      }
      // 2. détails + videos
      const detailsUrl = this.buildUrl(`/${best.media_type}/${best.id}`, { language: 'fr-FR', append_to_response: 'videos,images' });
      const detailsRes = await fetch(detailsUrl, { headers: this.headers });
      if (!detailsRes.ok) return this.mapCandidate(best);
      const details = (await detailsRes.json()) as Record<string, unknown>;
      return this.mapDetails(best, details);
    } catch {
      return null;
    }
  }

  private mapCandidate(c: { id: number; media_type: 'movie' | 'tv'; title?: string; name?: string; poster_path: string | null; backdrop_path: string | null; overview: string | null; release_date?: string; first_air_date?: string; vote_average?: number }): TmdbEnriched {
    const year = this.extractYear(c.media_type === 'movie' ? c.release_date : c.first_air_date);
    return {
      tmdbId: c.id,
      mediaType: c.media_type,
      title: c.title ?? c.name ?? '',
      overview: c.overview ?? null,
      posterUrl: c.poster_path ? `${TMDB_IMAGE_BASE}/w500${c.poster_path}` : null,
      backdropUrl: c.backdrop_path ? `${TMDB_IMAGE_BASE}/w1280${c.backdrop_path}` : null,
      genres: [],
      year,
      voteAverage: c.vote_average ?? null,
      trailerUrl: null,
    };
  }

  private mapDetails(
    candidate: { id: number; media_type: 'movie' | 'tv'; title?: string; name?: string; poster_path: string | null; backdrop_path: string | null; overview: string | null; vote_average?: number },
    details: Record<string, unknown>,
  ): TmdbEnriched {
    const base = this.mapCandidate(candidate);
    const videos = (details.videos as { results?: Array<{ site: string; type: string; key: string }> })?.results ?? [];
    const trailer = videos.find((v) => v.site === 'YouTube' && v.type === 'Trailer') ?? videos.find((v) => v.site === 'YouTube');
    const genres = ((details.genres as Array<{ name: string }>) ?? []).map((g) => g.name);
    const year = this.extractYear((details.release_date as string) ?? (details.first_air_date as string) ?? undefined) ?? base.year;
    const overview = (details.overview as string | null) ?? base.overview;
    return {
      ...base,
      overview,
      genres,
      year,
      trailerUrl: trailer ? `https://www.youtube.com/watch?v=${trailer.key}` : null,
    };
  }

  private extractYear(date?: string): number | null {
    if (!date) return null;
    const y = parseInt(date.slice(0, 4), 10);
    return Number.isFinite(y) ? y : null;
  }

  static attributionHtml(): string {
    return 'This product uses the TMDB API but is not endorsed or certified by TMDB.';
  }
}
