import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';

export interface ParsedMatch { sport: string; competition: string; homeTeam: string; awayTeam: string; }
interface SportProfile { sport: string; keywords: string[]; categoryKeywords: string[]; }
const SPORT_PROFILES: SportProfile[] = [
  { sport: 'Football', keywords: ['ligue 1','ligue 2','premier league','la liga','serie a','bundesliga','ligue des champions','champions league','ligue europa','europa league','ligue des conférences','conference league','ligue nations','nations league','coupe du monde','world cup','coupe de france','euro ','can 202'], categoryKeywords: ['football','soccer'] },
  { sport: 'Basketball', keywords: ['nba','euroleague','euroleague','wnba','pro a','betclic elite'], categoryKeywords: ['basketball','basket'] },
  { sport: 'Tennis', keywords: ['roland-garros','roland garros','wimbledon','us open','open d’australie','open d\'australie','australian open','atp','wta','masters 1000','grand chelem','grand slam','coupe davis'], categoryKeywords: ['tennis'] },
  { sport: 'Rugby', keywords: ['top 14','pro d2','six nations','tournoi des six nations','premiership','rugby championship','champions cup'], categoryKeywords: ['rugby'] },
  { sport: 'Cyclisme', keywords: ['tour de france','tour d’espagne','tour d\'espagne','vuelta','tour d’italie','tour d\'italie','giro','paris-roubaix','milan-san remo','mondiaux'], categoryKeywords: ['cyclisme','cycling'] },
  { sport: 'Boxe', keywords: ['boxe','boxing','combat de boxe'], categoryKeywords: ['boxe','boxing'] },
  { sport: 'MMA', keywords: ['ufc','mma','bellator','pfl'], categoryKeywords: ['mma','arts martiaux'] },
  { sport: 'Formule 1', keywords: ['formule 1','formula 1','grand prix','motogp','f1 '], categoryKeywords: ['formule 1','formula 1','motorsport','sport automobile'] },
  { sport: 'Handball', keywords: ['handball','euro de handball','championnat du monde de handball'], categoryKeywords: ['handball'] },
  { sport: 'Volley-ball', keywords: ['volley','ligue des nations de volley'], categoryKeywords: ['volley-ball','volleyball'] },
  { sport: 'Hockey sur glace', keywords: ['nhl','ligue nationale de hockey'], categoryKeywords: ['hockey'] },
];
const NON_MATCH_HINTS = ['documentaire','magazine','résumé','replay','rediffusion','rediff','best of','reportage','interview','débat','analyse','pub','arrêt'];
const SEPARATOR_PATTERN = /\s+(?:vs\.?|–|—|-)\s+/gi;
export function parseMatchTitle(title: string, categories: string[] = []): ParsedMatch | null { const cleaned = title.replace(/\b(live|en direct|direct|stream)\b/gi, ' ').replace(/\s+/g, ' ').trim(); if (cleaned.length === 0) return null; const lower = cleaned.toLowerCase(); if (NON_MATCH_HINTS.some((hint) => lower.includes(hint))) return null; if (/\d+\s*[-–—]\s*\d+/.test(cleaned)) return null; const sport = detectSport(cleaned, categories); if (!sport) return null; let competition = ''; let teamsPart = cleaned; const colonIndex = cleaned.indexOf(':'); if (colonIndex > 0) { competition = cleaned.slice(0, colonIndex).trim(); teamsPart = cleaned.slice(colonIndex + 1).trim(); } const separator = lastSeparator(teamsPart); if (!separator) return null; const homeTeam = teamsPart.slice(0, separator.index).trim(); let awayTeam = teamsPart.slice(separator.index + separator.length).trim(); awayTeam = awayTeam.split(SEPARATOR_PATTERN)[0]?.trim() ?? ''; if (!homeTeam || !awayTeam) return null; if (/^\d+$/.test(homeTeam) || /^\d+$/.test(awayTeam)) return null; if (competition.toLowerCase() === sport.toLowerCase()) competition = ''; return { sport, competition, homeTeam, awayTeam }; }
export function detectSport(text: string, categories: string[] = []): string | null { const lower = text.toLowerCase(); for (const profile of SPORT_PROFILES) if (profile.keywords.some((keyword) => lower.includes(keyword))) return profile.sport; const colonPrefix = lower.split(':')[0]?.trim(); if (colonPrefix) { const byName = SPORT_PROFILES.find((profile) => profile.sport.toLowerCase() === colonPrefix); if (byName) return byName.sport; } const categoryText = categories.join(' ').toLowerCase(); for (const profile of SPORT_PROFILES) if (profile.categoryKeywords.some((keyword) => categoryText.includes(keyword))) return profile.sport; if (categoryText.includes('sport')) return 'Sport'; return null; }
function lastSeparator(text: string): { index: number; length: number } | null { const matches = [...text.matchAll(SEPARATOR_PATTERN)]; if (matches.length === 0) return null; const last = matches[matches.length - 1]; if (last.index === undefined) return null; return { index: last.index, length: last[0].length }; }
export function normalizeTeams(homeTeam: string, awayTeam: string): string { const normalize = (value: string): string => value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, ''); return `${normalize(homeTeam)}|${normalize(awayTeam)}`; }
export interface DiscoveryResult { programmes: number; matchesCreated: number; matchesLinked: number; stateUpdates: number; removed: number; durationMs: number; }
const DEDUP_BUCKET_MS = 3 * 3_600_000; const POSTPONED_GRACE_MS = 2 * 3_600_000; const FINISHED_RETENTION_MS = 24 * 3_600_000;
interface MatchProgramme { channelId: string; title: string; metadata: unknown; startsAt: Date; endsAt: Date; }
interface ExistingMatch { id: string; sport: string; homeTeam: string; awayTeam: string; startsAt: Date; endsAt: Date | null; }
interface VariantPriority { id: string; priority: number; }

@Injectable()
export class MatchesDiscoveryService {
  private readonly logger = new Logger(MatchesDiscoveryService.name); private readonly enabled: boolean; private readonly lookaheadHours: number; private readonly pastHours: number;
  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService) { this.enabled = this.config.get('MATCH_DETECTION_ENABLED', 'true') !== 'false'; this.lookaheadHours = Number(this.config.get('MATCH_LOOKAHEAD_HOURS', 48)); this.pastHours = Number(this.config.get('MATCH_PAST_HOURS', 6)); }
  @Cron('*/15 * * * *') async scheduledRun(): Promise<void> { if (!this.enabled) return; await this.discover(); }
  async discover(): Promise<DiscoveryResult> {
    const startedAt = Date.now(); const from = new Date(startedAt - this.pastHours * 3_600_000); const to = new Date(startedAt + this.lookaheadHours * 3_600_000);
    const [programmes, variantsByChannel, existingMatches] = await Promise.all([this.prisma.epgProgramme.findMany({ where: { startsAt: { gte: from, lt: to }, channel: { variants: { some: { isActive: true } } } }, orderBy: { startsAt: 'asc' }, take: 5000 }), this.loadVariantsByChannel(), this.loadExistingMatches(from, to)]);
    const matchesByKey = new Map<string, ExistingMatch[]>(); for (const match of existingMatches) { const key = normalizeTeams(match.homeTeam, match.awayTeam); const list = matchesByKey.get(key) ?? []; list.push(match); matchesByKey.set(key, list); }
    let matchesCreated = 0; let matchesLinked = 0;
    for (const programme of programmes as MatchProgramme[]) {
      const categories = parseCategories(programme.metadata); const parsed = parseMatchTitle(programme.title, categories); if (!parsed) continue;
      const key = normalizeTeams(parsed.homeTeam, parsed.awayTeam); const candidates = matchesByKey.get(key) ?? []; const existing = candidates.find((match: ExistingMatch) => Math.abs(match.startsAt.getTime() - programme.startsAt.getTime()) <= DEDUP_BUCKET_MS && match.sport === parsed.sport);
      let matchId = existing?.id;
      if (!matchId) { const created = await this.prisma.match.create({ data: { sport: parsed.sport, competition: parsed.competition, homeTeam: parsed.homeTeam, awayTeam: parsed.awayTeam, startsAt: programme.startsAt, endsAt: programme.endsAt, state: 'SCHEDULED' } }); matchId = created.id; candidates.push({ id: created.id, sport: created.sport, homeTeam: created.homeTeam, awayTeam: created.awayTeam, startsAt: programme.startsAt, endsAt: programme.endsAt }); matchesByKey.set(key, candidates); matchesCreated += 1; }
      const variants = variantsByChannel.get(programme.channelId) ?? []; if (variants.length === 0) continue;
      const existingLinks = await this.prisma.matchStream.findMany({ where: { matchId: matchId as string }, select: { streamVariantId: true } }); const existingIds = new Set(existingLinks.map((link: { streamVariantId: string }) => link.streamVariantId)); const missing = variants.filter((variant: VariantPriority) => !existingIds.has(variant.id)); if (missing.length === 0) continue;
      const linked = await this.prisma.matchStream.createMany({ data: missing.map((variant: VariantPriority) => ({ matchId: matchId as string, streamVariantId: variant.id, priority: variant.priority })) }); matchesLinked += linked.count;
    }
    const stateUpdates = await this.refreshStates(new Date(startedAt)); const removed = await this.purgeFinished(); this.logger.log(`Matchs: ${matchesCreated} créés, ${matchesLinked} liens, ${stateUpdates} états, ${removed} purgés, ${programmes.length} programmes analysés`); return { programmes: programmes.length, matchesCreated, matchesLinked, stateUpdates, removed, durationMs: Date.now() - startedAt };
  }
  private async loadVariantsByChannel(): Promise<Map<string, VariantPriority[]>> {
    const variants = await this.prisma.streamVariant.findMany({ where: { isActive: true }, select: { id: true, channelId: true, sourceId: true } }); const sourceIds = [...new Set(variants.map((variant: { sourceId: string }) => variant.sourceId))];
    const sources = await this.prisma.source.findMany({ where: { id: { in: sourceIds } }, select: { id: true, priority: true } }); const priorityBySource = new Map(sources.map((source: { id: string; priority: number }) => [source.id, source.priority])); const map = new Map<string, VariantPriority[]>();
    for (const variant of variants) { const priority = priorityBySource.get(variant.sourceId); if (priority === undefined) continue; const list = map.get(variant.channelId) ?? []; list.push({ id: variant.id, priority }); map.set(variant.channelId, list); }
    return map;
  }
  private async loadExistingMatches(from: Date, to: Date): Promise<ExistingMatch[]> { const windowFrom = new Date(from.getTime() - DEDUP_BUCKET_MS); const windowTo = new Date(to.getTime() + DEDUP_BUCKET_MS); return this.prisma.match.findMany({ where: { startsAt: { gte: windowFrom, lte: windowTo }, state: { in: ['SCHEDULED', 'LIVE', 'POSTPONED'] } }, select: { id: true, sport: true, homeTeam: true, awayTeam: true, startsAt: true, endsAt: true } }); }
  private async refreshStates(now: Date): Promise<number> { const live = await this.prisma.match.updateMany({ where: { state: 'SCHEDULED', startsAt: { lte: now }, endsAt: { gt: now } }, data: { state: 'LIVE' } }); const finished = await this.prisma.match.updateMany({ where: { state: { in: ['SCHEDULED', 'LIVE', 'POSTPONED'] }, endsAt: { lt: now } }, data: { state: 'FINISHED' } }); const grace = new Date(now.getTime() - POSTPONED_GRACE_MS); const postponed = await this.prisma.match.updateMany({ where: { state: 'SCHEDULED', startsAt: { lt: grace }, endsAt: { gte: now } }, data: { state: 'POSTPONED' } }); return live.count + finished.count + postponed.count; }
  private async purgeFinished(): Promise<number> { const cutoff = new Date(Date.now() - FINISHED_RETENTION_MS); const result = await this.prisma.match.deleteMany({ where: { state: 'FINISHED', endsAt: { lt: cutoff } } }); return result.count; }
}
function parseCategories(metadata: unknown): string[] { if (!metadata || typeof metadata !== 'object') return []; const categories = (metadata as { categories?: unknown }).categories; if (!Array.isArray(categories)) return []; return categories.filter((category): category is string => typeof category === 'string'); }
