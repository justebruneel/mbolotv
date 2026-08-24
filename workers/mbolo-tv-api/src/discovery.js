// Réplique de matches-discovery.service.ts : détection de matchs depuis l'EPG.
const SPORT_PROFILES = [
  { sport: 'Football', keywords: ['ligue 1', 'ligue 2', 'premier league', 'la liga', 'serie a', 'bundesliga', 'ligue des champions', 'champions league', 'ligue europa', 'europa league', 'ligue des conférences', 'conference league', 'ligue nations', 'nations league', 'coupe du monde', 'world cup', 'coupe de france', 'euro ', 'can 202'], categoryKeywords: ['football', 'soccer'] },
  { sport: 'Basketball', keywords: ['nba', 'euroleague', 'wnba', 'pro a', 'betclic elite'], categoryKeywords: ['basketball', 'basket'] },
  { sport: 'Tennis', keywords: ['roland-garros', 'roland garros', 'wimbledon', 'us open', 'open d’australie', "open d'australie", 'australian open', 'atp', 'wta', 'masters 1000', 'grand chelem', 'grand slam', 'coupe davis'], categoryKeywords: ['tennis'] },
  { sport: 'Rugby', keywords: ['top 14', 'pro d2', 'six nations', 'tournoi des six nations', 'premiership', 'rugby championship', 'champions cup'], categoryKeywords: ['rugby'] },
  { sport: 'Cyclisme', keywords: ['tour de france', 'tour d’espagne', "tour d'espagne", 'vuelta', 'tour d’italie', "tour d'italie", 'giro', 'paris-roubaix', 'milan-san remo', 'mondiaux'], categoryKeywords: ['cyclisme', 'cycling'] },
  { sport: 'Boxe', keywords: ['boxe', 'boxing', 'combat de boxe'], categoryKeywords: ['boxe', 'boxing'] },
  { sport: 'MMA', keywords: ['ufc', 'mma', 'bellator', 'pfl'], categoryKeywords: ['mma', 'arts martiaux'] },
  { sport: 'Formule 1', keywords: ['formule 1', 'formula 1', 'grand prix', 'motogp', 'f1 '], categoryKeywords: ['formule 1', 'formula 1', 'motorsport', 'sport automobile'] },
  { sport: 'Handball', keywords: ['handball', 'euro de handball', 'championnat du monde de handball'], categoryKeywords: ['handball'] },
  { sport: 'Volley-ball', keywords: ['volley', 'ligue des nations de volley'], categoryKeywords: ['volley-ball', 'volleyball'] },
  { sport: 'Hockey sur glace', keywords: ['nhl', 'ligue nationale de hockey'], categoryKeywords: ['hockey'] },
];
const NON_MATCH_HINTS = ['documentaire', 'magazine', 'résumé', 'replay', 'rediffusion', 'rediff', 'best of', 'reportage', 'interview', 'débat', 'analyse', 'pub', 'arrêt'];
const SEPARATOR_PATTERN = /\s+(?:vs\.?|–|—|-)\s+/gi;
const DEDUP_BUCKET_MS = 3 * 3_600_000;
const POSTPONED_GRACE_MS = 2 * 3_600_000;
const FINISHED_RETENTION_MS = 24 * 3_600_000;

function detectSport(text, categories) {
  const lower = text.toLowerCase();
  for (const profile of SPORT_PROFILES) if (profile.keywords.some((keyword) => lower.includes(keyword))) return profile.sport;
  const colonPrefix = lower.split(':')[0]?.trim();
  if (colonPrefix) {
    const byName = SPORT_PROFILES.find((profile) => profile.sport.toLowerCase() === colonPrefix);
    if (byName) return byName.sport;
  }
  const categoryText = categories.join(' ').toLowerCase();
  for (const profile of SPORT_PROFILES) if (profile.categoryKeywords.some((keyword) => categoryText.includes(keyword))) return profile.sport;
  if (categoryText.includes('sport')) return 'Sport';
  return null;
}

function lastSeparator(text) {
  const matches = [...text.matchAll(SEPARATOR_PATTERN)];
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1];
  if (last.index === undefined) return null;
  return { index: last.index, length: last[0].length };
}

export function normalizeTeams(homeTeam, awayTeam) {
  const normalize = (value) => value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
  return `${normalize(homeTeam)}|${normalize(awayTeam)}`;
}

export function parseMatchTitle(title, categories = []) {
  const cleaned = title.replace(/\b(live|en direct|direct|stream)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0) return null;
  const lower = cleaned.toLowerCase();
  if (NON_MATCH_HINTS.some((hint) => lower.includes(hint))) return null;
  if (/\d+\s*[-–—]\s*\d+/.test(cleaned)) return null;
  const sport = detectSport(cleaned, categories);
  if (!sport) return null;
  let competition = '';
  let teamsPart = cleaned;
  const colonIndex = cleaned.indexOf(':');
  if (colonIndex > 0) { competition = cleaned.slice(0, colonIndex).trim(); teamsPart = cleaned.slice(colonIndex + 1).trim(); }
  const separator = lastSeparator(teamsPart);
  if (!separator) return null;
  const homeTeam = teamsPart.slice(0, separator.index).trim();
  let awayTeam = teamsPart.slice(separator.index + separator.length).trim();
  awayTeam = awayTeam.split(SEPARATOR_PATTERN)[0]?.trim() ?? '';
  if (!homeTeam || !awayTeam) return null;
  if (/^\d+$/.test(homeTeam) || /^\d+$/.test(awayTeam)) return null;
  if (competition.toLowerCase() === sport.toLowerCase()) competition = '';
  return { sport, competition, homeTeam, awayTeam };
}

function parseCategories(metadata) {
  if (!metadata || typeof metadata !== 'object') return [];
  const categories = metadata.categories;
  return Array.isArray(categories) ? categories.filter((category) => typeof category === 'string') : [];
}

export async function discoverMatches(env) {
  if ((env.MATCH_DETECTION_ENABLED ?? 'true') === 'false') return { skipped: true };
  const lookaheadHours = Number(env.MATCH_LOOKAHEAD_HOURS ?? 48);
  const pastHours = Number(env.MATCH_PAST_HOURS ?? 6);
  const now = Date.now();
  const from = new Date(now - pastHours * 3_600_000);
  const to = new Date(now + lookaheadHours * 3_600_000);

  const programmes = await env.db.query(
    env,
    `SELECT p."channelId", p.title, p.metadata, p."startsAt", p."endsAt" FROM "EpgProgramme" p
     WHERE p."startsAt" >= $1 AND p."startsAt" < $2 AND EXISTS (SELECT 1 FROM "StreamVariant" v WHERE v."channelId" = p."channelId" AND v."isActive")
     ORDER BY p."startsAt" ASC LIMIT 5000`,
    [from, to],
  );
  const variants = await env.db.query(
    env,
    `SELECT v.id, v."channelId", s.priority FROM "StreamVariant" v JOIN "Source" s ON s.id = v."sourceId" WHERE v."isActive"`,
  );
  const priorityByVariant = new Map(variants.rows.map((row) => [row.id, row.priority]));
  const variantsByChannel = new Map();
  for (const row of variants.rows) {
    const list = variantsByChannel.get(row.channelId) ?? [];
    list.push({ id: row.id, priority: row.priority });
    variantsByChannel.set(row.channelId, list);
  }

  const windowFrom = new Date(from.getTime() - DEDUP_BUCKET_MS);
  const windowTo = new Date(to.getTime() + DEDUP_BUCKET_MS);
  const existing = await env.db.query(
    env,
    `SELECT id, sport, "homeTeam", "awayTeam", "startsAt", "endsAt" FROM "Match"
     WHERE "startsAt" >= $1 AND "startsAt" <= $2 AND state IN ('SCHEDULED','LIVE','POSTPONED')`,
    [windowFrom, windowTo],
  );
  const matchesByKey = new Map();
  for (const match of existing.rows) {
    const key = normalizeTeams(match.homeTeam, match.awayTeam);
    const list = matchesByKey.get(key) ?? [];
    list.push(match);
    matchesByKey.set(key, list);
  }

  let matchesCreated = 0;
  let matchesLinked = 0;
  for (const programme of programmes.rows) {
    const parsed = parseMatchTitle(programme.title, parseCategories(programme.metadata));
    if (!parsed) continue;
    const key = normalizeTeams(parsed.homeTeam, parsed.awayTeam);
    const candidates = matchesByKey.get(key) ?? [];
    const found = candidates.find((match) => Math.abs(new Date(match.startsAt).getTime() - new Date(programme.startsAt).getTime()) <= DEDUP_BUCKET_MS && match.sport === parsed.sport);
    let matchId = found?.id;
    if (!matchId) {
      const created = await env.db.query(
        env,
        `INSERT INTO "Match" (id, sport, competition, "homeTeam", "awayTeam", "startsAt", "endsAt", state)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'SCHEDULED') RETURNING id`,
        [crypto.randomUUID(), parsed.sport, parsed.competition, parsed.homeTeam, parsed.awayTeam, new Date(programme.startsAt), programme.endsAt ? new Date(programme.endsAt) : null],
      );
      matchId = created.rows[0].id;
      candidates.push({ id: matchId, sport: parsed.sport, startsAt: programme.startsAt });
      matchesByKey.set(key, candidates);
      matchesCreated += 1;
    }
    const channelVariants = variantsByChannel.get(programme.channelId) ?? [];
    if (channelVariants.length === 0) continue;
    const links = await env.db.query(env, `SELECT "streamVariantId" FROM "MatchStream" WHERE "matchId" = $1`, [matchId]);
    const existingIds = new Set(links.rows.map((link) => link.streamVariantId));
    const missing = channelVariants.filter((variant) => !existingIds.has(variant.id));
    if (missing.length === 0) continue;
    for (const variant of missing) {
      await env.db.query(env, `INSERT INTO "MatchStream" (id, "matchId", "streamVariantId", priority) VALUES ($1,$2,$3,$4) ON CONFLICT ("matchId","streamVariantId") DO NOTHING`, [crypto.randomUUID(), matchId, variant.id, priorityByVariant.get(variant.id) ?? 100]);
      matchesLinked += 1;
    }
  }

  const live = await env.db.query(env, `UPDATE "Match" SET state = 'LIVE' WHERE state = 'SCHEDULED' AND "startsAt" <= now() AND ("endsAt" IS NULL OR "endsAt" > now())`);
  const finished = await env.db.query(env, `UPDATE "Match" SET state = 'FINISHED' WHERE state IN ('SCHEDULED','LIVE','POSTPONED') AND "endsAt" < now()`);
  const postponed = await env.db.query(env, `UPDATE "Match" SET state = 'POSTPONED' WHERE state = 'SCHEDULED' AND "startsAt" < now() - interval '2 hours' AND "endsAt" >= now()`);
  const removed = await env.db.query(env, `DELETE FROM "Match" WHERE state = 'FINISHED' AND "endsAt" < now() - interval '24 hours'`);

  return { matchesCreated, matchesLinked, stateUpdates: live.rowCount + finished.rowCount + postponed.rowCount, removed: removed.rowCount };
}
