import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * « À la une » football — calendriers TheSportsDB (https://www.thesportsdb.com/api.php),
 * appariés aux chaînes de notre EPG pour indiquer la diffusion.
 *
 * LIMITES DE L'API (documentées pour savoir où ça peut casser) :
 * - Clé tier gratuit : https://www.thesportsdb.com/api.php — la clé de test
 *   publique « 3 » fonctionne mais renvoie un nombre d'événements restreint
 *   (souvent 1 seul par appel). Enregistrer une clé gratuite pour plus de
 *   résultats (v2 recommandée en cas de montée en charge).
 * - Endpoints /eventsnextleague.php limités aux prochains événements de la
 *   ligue ; pas d'historique complet en tier gratuit.
 * - `strTimestamp` est en UTC (peut être null → fallback dateEvent + strTime).
 * - Appels : 6 ligues × 1 requête toutes les 6 h ≈ 24 req/jour, très loin du
 *   plafond du tier gratuit (30 req/min).
 * - Couverture : noms d'équipes en anglais (« Real Madrid ») ; l'appariement
 *   EPG est tolérant aux accents mais pas aux traductions divergentes.
 */

interface SportsdbEvent {
  idEvent: string;
  strEvent: string;
  strLeague: string;
  strHomeTeam: string;
  strAwayTeam: string;
  dateEvent?: string | null;
  strTime?: string | null;
  strTimestamp?: string | null;
  strHomeTeamBadge?: string | null;
  strAwayTeamBadge?: string | null;
}

const SPORTSDB_BASE = 'https://www.thesportsdb.com/api/v1/json';

// Priorité décroissante : la Champions League et les grands championnats
// européens remontent en premier dans la section « À la une ».
const LEAGUES = [
  { id: '4480', name: 'UEFA Champions League', priority: 1 },
  { id: '4328', name: 'English Premier League', priority: 2 },
  { id: '4335', name: 'Spanish La Liga', priority: 3 },
  { id: '4334', name: 'French Ligue 1', priority: 4 },
  { id: '4332', name: 'Italian Serie A', priority: 5 },
  { id: '4331', name: 'German Bundesliga', priority: 6 },
];

function normalizeTeam(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(fc|cf|sc|ac|as|afc|cfc)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isSameTeam(a: string, b: string): boolean {
  const na = normalizeTeam(a);
  const nb = normalizeTeam(b);
  if (!na || !nb) return false;
  return na === nb || (na.includes(nb) && nb.length >= 4) || (nb.includes(na) && na.length >= 4);
}

const SYNC_WINDOW_PAST_MS = 6 * 3_600_000;
const SYNC_WINDOW_FUTURE_MS = 8 * 24 * 3_600_000;
const DISCOVERY_DEDUP_MS = 12 * 3_600_000;
const LINK_WINDOW_PAST_MS = 4 * 3_600_000;
const LINK_WINDOW_FUTURE_MS = 1 * 3_600_000;

@Injectable()
export class FootballScheduleService {
  private readonly logger = new Logger(FootballScheduleService.name);
  private readonly apiKey: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    // Clé de test publique « 3 » par défaut (fonctionne, résultats limités) ;
    // surcharger via SPORTSDB_API_KEY avec une clé gratuite personnelle.
    this.apiKey = config.get<string>('SPORTSDB_API_KEY') ?? '3';
  }

  @Cron('0 */6 * * *')
  async scheduledRun(): Promise<void> {
    try {
      await this.sync();
    } catch (error) {
      this.logger.warn(`Sync agenda football échouée: ${String((error as Error).message ?? error)}`);
    }
  }

  async sync(): Promise<{ matches: number; linked: number }> {
    let matches = 0;
    let linked = 0;
    const now = Date.now();
    for (const league of LEAGUES) {
      const events = await this.fetchNextEvents(league.id);
      for (const event of events) {
        const startsAt = this.parseStart(event);
        if (!startsAt) continue;
        if (startsAt.getTime() < now - SYNC_WINDOW_PAST_MS || startsAt.getTime() > now + SYNC_WINDOW_FUTURE_MS) continue;

        const match = await this.upsertMatch(event, league.name, startsAt);
        if (!match) continue;
        matches += 1;
        linked += await this.linkChannels(match.id, event.strHomeTeam, event.strAwayTeam, startsAt);
      }
    }
    this.logger.log(`Agenda football: ${matches} matchs synchronisés, ${linked} liaisons chaînes`);
    return { matches, linked };
  }

  private async fetchNextEvents(leagueId: string): Promise<SportsdbEvent[]> {
    try {
      const res = await fetch(`${SPORTSDB_BASE}/${this.apiKey}/eventsnextleague.php?id=${leagueId}`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { events?: SportsdbEvent[] | null };
      return data.events ?? [];
    } catch {
      return [];
    }
  }

  private parseStart(event: SportsdbEvent): Date | null {
    // strTimestamp : "2026-09-04T19:00:00" en UTC. Fallback dateEvent + strTime.
    const raw = event.strTimestamp ?? (event.dateEvent && event.strTime ? `${event.dateEvent}T${event.strTime}` : null);
    if (!raw) return null;
    const iso = raw.includes('T') ? raw : `${raw.slice(0, 10)}T${raw.slice(11) || '00:00:00'}`;
    const date = new Date(`${iso.replace(' ', 'T')}Z`);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  private async upsertMatch(event: SportsdbEvent, leagueName: string, startsAt: Date): Promise<{ id: string } | null> {
    const externalId = `thesportsdb:${event.idEvent}`;
    const existing = await this.prisma.match.findUnique({ where: { externalId } });
    const data = {
      competition: leagueName,
      homeTeam: event.strHomeTeam,
      awayTeam: event.strAwayTeam,
      homeTeamLogo: event.strHomeTeamBadge ?? null,
      awayTeamLogo: event.strAwayTeamBadge ?? null,
    };
    if (existing) {
      await this.prisma.match.update({ where: { id: existing.id }, data: { startsAt, ...data } }).catch(() => {});
      return { id: existing.id };
    }
    // Évite le doublon avec un match déjà découvert depuis l'EPG (mêmes équipes
    // au voisinage horaire) : on réutilise cette ligne (noms EPG conservés).
    const from = new Date(startsAt.getTime() - DISCOVERY_DEDUP_MS);
    const to = new Date(startsAt.getTime() + DISCOVERY_DEDUP_MS);
    const candidates = await this.prisma.match.findMany({
      where: { sport: 'Football', startsAt: { gte: from, lte: to }, state: { in: ['SCHEDULED', 'LIVE'] } },
      select: { id: true, homeTeam: true, awayTeam: true },
      take: 50,
    });
    const similar = candidates.find(
      (row) =>
        (isSameTeam(row.homeTeam, event.strHomeTeam) && isSameTeam(row.awayTeam, event.strAwayTeam)) ||
        (isSameTeam(row.homeTeam, event.strAwayTeam) && isSameTeam(row.awayTeam, event.strHomeTeam)),
    );
    if (similar) {
      await this.prisma.match.update({ where: { id: similar.id }, data: { homeTeamLogo: data.homeTeamLogo, awayTeamLogo: data.awayTeamLogo } }).catch(() => {});
      return { id: similar.id };
    }
    const created = await this.prisma.match
      .create({
        data: {
          sport: 'Football',
          competition: leagueName,
          homeTeam: event.strHomeTeam,
          awayTeam: event.strAwayTeam,
          startsAt,
          state: 'SCHEDULED',
          externalId,
          homeTeamLogo: data.homeTeamLogo,
          awayTeamLogo: data.awayTeamLogo,
        },
        select: { id: true },
      })
      .catch(() => null);
    return created;
  }

  /** Relie le match aux chaînes diffusant un programme EPG citant les équipes. */
  private async linkChannels(matchId: string, homeTeam: string, awayTeam: string, startsAt: Date): Promise<number> {
    const from = new Date(startsAt.getTime() - LINK_WINDOW_PAST_MS);
    const to = new Date(startsAt.getTime() + LINK_WINDOW_FUTURE_MS);
    const homeToken = normalizeTeam(homeTeam);
    const awayToken = normalizeTeam(awayTeam);
    if (!homeToken && !awayToken) return 0;
    const programmes = await this.prisma.epgProgramme.findMany({
      where: {
        startsAt: { gte: from, lte: to },
        OR: [{ title: { contains: homeToken.split(' ')[0] ?? homeToken, mode: 'insensitive' } }, { title: { contains: awayToken.split(' ')[0] ?? awayToken, mode: 'insensitive' } }],
      },
      select: { channelId: true, title: true },
      take: 100,
    });
    // Confirme la correspondance avec les deux équipes (nom complet) pour
    // limiter les faux positifs du premier mot (ex : "Real" tout court).
    const confirmed = programmes.filter((p) => {
      const title = normalizeTeam(p.title);
      return title.includes(homeToken) || title.includes(awayToken);
    });
    const channelIds = [...new Set(confirmed.map((p) => p.channelId))];
    let linked = 0;
    for (const channelId of channelIds) {
      const variant = await this.prisma.streamVariant.findFirst({
        where: { channelId, isActive: true },
        orderBy: { healthScore: 'desc' },
        select: { id: true },
      });
      if (!variant) continue;
      await this.prisma.matchStream
        .create({ data: { matchId, streamVariantId: variant.id, priority: 100 } })
        .catch(() => {}); // conflit @@unique(matchId, streamVariantId) = déjà lié
      linked += 1;
    }
    return linked;
  }
}
