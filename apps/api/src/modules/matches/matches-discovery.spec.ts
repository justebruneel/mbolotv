import { MatchesDiscoveryService, parseMatchTitle } from './matches-discovery.service';

describe('parseMatchTitle', () => {
  it('parse "Ligue 1 : PSG - OM"', () => {
    expect(parseMatchTitle('Ligue 1 : PSG - OM')).toEqual({
      sport: 'Football',
      competition: 'Ligue 1',
      homeTeam: 'PSG',
      awayTeam: 'OM',
    });
  });

  it('parse "Premier League: Liverpool vs Man City"', () => {
    expect(parseMatchTitle('Premier League: Liverpool vs Man City')).toEqual({
      sport: 'Football',
      competition: 'Premier League',
      homeTeam: 'Liverpool',
      awayTeam: 'Man City',
    });
  });

  it('parse "NBA: Lakers - Celtics"', () => {
    expect(parseMatchTitle('NBA: Lakers - Celtics')).toEqual({
      sport: 'Basketball',
      competition: 'NBA',
      homeTeam: 'Lakers',
      awayTeam: 'Celtics',
    });
  });

  it('parse "UFC 300: Adesanya vs Pereira"', () => {
    expect(parseMatchTitle('UFC 300: Adesanya vs Pereira')).toEqual({
      sport: 'MMA',
      competition: 'UFC 300',
      homeTeam: 'Adesanya',
      awayTeam: 'Pereira',
    });
  });

  it('ne garde pas la compétition quand elle est réduite au sport ("Tennis: Djokovic - Alcaraz")', () => {
    expect(parseMatchTitle('Tennis: Djokovic - Alcaraz')).toEqual({
      sport: 'Tennis',
      competition: '',
      homeTeam: 'Djokovic',
      awayTeam: 'Alcaraz',
    });
  });

  it('utilise les catégories XMLTV quand le titre est nu ("PSG - OM" + catégorie Football)', () => {
    expect(parseMatchTitle('PSG - OM', ['Football'])).toEqual({
      sport: 'Football',
      competition: '',
      homeTeam: 'PSG',
      awayTeam: 'OM',
    });
  });

  it('rejette les programmes de résumé, même suffixés ("Ligue 1: PSG - OM - Résumé")', () => {
    expect(parseMatchTitle('Ligue 1: PSG - OM - Résumé')).toBeNull();
  });

  it('ignore les programmes non sportifs (magazine, documentaire, résumé)', () => {
    expect(parseMatchTitle('Football : Magazine de la Ligue 1')).toBeNull();
    expect(parseMatchTitle('Résumé : PSG - OM')).toBeNull();
    expect(parseMatchTitle('Documentaire : PSG - OM', ['Football'])).toBeNull();
  });

  it('ignore les titres sans paire d’équipes', () => {
    expect(parseMatchTitle('Football : Grand débat')).toBeNull();
    expect(parseMatchTitle('Tennis : Alcaraz en conférence')).toBeNull();
  });

  it('ignore les scores purs ("France 2 - 1 Angleterre")', () => {
    expect(parseMatchTitle('France 2 - 1 Angleterre', ['Football'])).toBeNull();
  });
});

describe('MatchesDiscoveryService.discover', () => {
  function buildService(prisma: Record<string, unknown>) {
    const service = new MatchesDiscoveryService(prisma as never, {
      get: jest.fn((key: string, fallback?: unknown) => fallback),
    } as never);
    return service;
  }

  it('crée un match et lie les variantes actives de la chaîne porteuse', async () => {
    const startsAt = new Date('2026-08-16T20:00:00.000Z');
    const endsAt = new Date('2026-08-16T22:30:00.000Z');

    const created = {
      id: 'match-1',
      sport: 'Football',
      competition: 'Ligue 1',
      homeTeam: 'PSG',
      awayTeam: 'OM',
      startsAt,
      endsAt,
      state: 'SCHEDULED',
    };

    const createManyCalls: Array<{ data: unknown[] }> = [];
    const service = buildService({
      epgProgramme: {
        findMany: jest.fn(async () => [
          {
            channelId: 'channel-1',
            title: 'Ligue 1 : PSG - OM',
            description: null,
            metadata: { categories: ['Football'] },
            startsAt,
            endsAt,
          },
        ]),
      },
      streamVariant: {
        findMany: jest.fn(async () => [
          { id: 'v1', channelId: 'channel-1', sourceId: 'src-1' },
          { id: 'v2', channelId: 'channel-1', sourceId: 'src-2' },
        ]),
      },
      source: {
        findMany: jest.fn(async () => [
          { id: 'src-1', priority: 10 },
          { id: 'src-2', priority: 50 },
        ]),
      },
      match: {
        findMany: jest.fn(async () => []),
        create: jest.fn(async () => created),
        updateMany: jest.fn(async () => ({ count: 0 })),
        deleteMany: jest.fn(async () => ({ count: 0 })),
      },
      matchStream: {
        findMany: jest.fn(async () => []),
        createMany: jest.fn(async (args: { data: unknown[] }) => {
          createManyCalls.push(args);
          return { count: args.data.length };
        }),
      },
    });

    const result = await service.discover();

    expect(result.matchesCreated).toBe(1);
    expect(result.matchesLinked).toBe(2);
    expect(createManyCalls[0].data).toEqual([
      { matchId: 'match-1', streamVariantId: 'v1', priority: 10 },
      { matchId: 'match-1', streamVariantId: 'v2', priority: 50 },
    ]);
  });

  it('déduplique les programmes identiques sur la même fenêtre horaire', async () => {
    const startsAt = new Date('2026-08-16T20:00:00.000Z');
    const endsAt = new Date('2026-08-16T22:30:00.000Z');

    const service = buildService({
      epgProgramme: {
        findMany: jest.fn(async () => [
          { channelId: 'channel-1', title: 'Ligue 1 : PSG - OM', metadata: null, startsAt, endsAt },
          { channelId: 'channel-2', title: 'Ligue 1: PSG - OM', metadata: null, startsAt, endsAt },
        ]),
      },
      streamVariant: {
        findMany: jest.fn(async () => [
          { id: 'v1', channelId: 'channel-1', sourceId: 'src-1' },
          { id: 'v2', channelId: 'channel-2', sourceId: 'src-2' },
        ]),
      },
      source: {
        findMany: jest.fn(async () => [
          { id: 'src-1', priority: 10 },
          { id: 'src-2', priority: 50 },
        ]),
      },
      match: {
        findMany: jest.fn(async () => []),
        create: jest.fn(async () => ({
          id: 'match-1',
          sport: 'Football',
          competition: 'Ligue 1',
          homeTeam: 'PSG',
          awayTeam: 'OM',
          startsAt,
          endsAt,
          state: 'SCHEDULED',
        })),
        updateMany: jest.fn(async () => ({ count: 0 })),
        deleteMany: jest.fn(async () => ({ count: 0 })),
      },
      matchStream: {
        findMany: jest.fn(async () => []),
        createMany: jest.fn(async () => ({ count: 1 })),
      },
    });

    const result = await service.discover();

    expect(result.matchesCreated).toBe(1);
    expect(result.matchesLinked).toBe(2);
  });
});