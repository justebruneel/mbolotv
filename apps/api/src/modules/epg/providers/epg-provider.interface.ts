export type EpgProgrammeType =
  | 'movie'
  | 'series'
  | 'episode'
  | 'sports'
  | 'documentary'
  | 'show'
  | 'news'
  | 'kids'
  | 'other';

export interface TVProgram {
  /** Identifiant externe du programme (généré) */
  id: string;
  /** Identifiant brut du channel dans le flux XMLTV (ex: TF1.fr) */
  externalChannelId: string;
  title: string;
  description?: string | null;
  startTime: Date;
  endTime: Date;
  type?: EpgProgrammeType;
  seasonNumber?: number;
  episodeNumber?: number;
  posterUrl?: string | null;
  backdropUrl?: string | null;
  categories?: string[];
  metadataSource?: string;
}

export interface EpgProvider {
  readonly name: string;
  /** URL source (pour logs) */
  getSourceUrl(): string | null;
  /** Stream XMLTV brut (Readable) */
  fetchXmltv(): Promise<ReadableStream<Uint8Array> | NodeJS.ReadableStream>;
  /** Optionnel : info fraîcheur */
  getFreshness?(): Promise<{ lastUpdated?: Date; days: number }>;
}

export interface ProviderCoverage {
  provider: string;
  totalChannels: number;
  matchedChannels: number;
  unmatchedSample: string[];
  freshness?: Date;
}

export function normalizeCategoryToType(categories: string[]): EpgProgrammeType {
  const joined = categories.join(' ').toLowerCase();
  if (/film|movie|cinéma|cinema/i.test(joined)) return 'movie';
  if (/série|serie|series|feuilleton/i.test(joined)) return 'series';
  if (/sport|football|rugby|tennis|basket|match/i.test(joined)) return 'sports';
  if (/documentaire|documentary/i.test(joined)) return 'documentary';
  if (/journal|news|info/i.test(joined)) return 'news';
  if (/jeunesse|kids|dessin|enfant|animation/i.test(joined)) return 'kids';
  if (/emission|émission|show|divertissement/i.test(joined)) return 'show';
  if (joined) return 'other';
  return 'other';
}

export function parseEpisodeNum(episodeNum: string | null | undefined): { season?: number; episode?: number } {
  if (!episodeNum) return {};
  // xmltv_ns : 0.1. -> S01E02 (0-indexed)
  const m = episodeNum.match(/(\d+)\.(\d+)\.?(\d+)?/);
  if (m) {
    const season = parseInt(m[1], 10) + 1;
    const episode = parseInt(m[2], 10) + 1;
    return { season: Number.isFinite(season) ? season : undefined, episode: Number.isFinite(episode) ? episode : undefined };
  }
  return {};
}
