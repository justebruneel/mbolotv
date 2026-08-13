import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const CATEGORIES = [
  { slug: 'sport', name: 'Sport' },
  { slug: 'actualites', name: 'Actualités' },
  { slug: 'cinema-series', name: 'Cinéma & Séries' },
  { slug: 'documentaires', name: 'Documentaires' },
  { slug: 'musique', name: 'Musique' },
  { slug: 'enfants', name: 'Enfants' },
  { slug: 'divertissement', name: 'Divertissement' },
  { slug: 'international', name: 'International' },
];

const CHANNELS_BY_CATEGORY: Record<string, Array<[name: string, country: string]>> = {
  sport: [
    ['Sport 24', 'FR'],
    ['Kora Sports', 'CI'],
    ['Teranga Sport', 'SN'],
    ['Canal Foot', 'CM'],
    ['Ligue Arena', 'FR'],
    ['Africa Games', 'MA'],
    ['Rugby TV', 'FR'],
    ['Basket Zone', 'FR'],
    ['Combat Live', 'FR'],
    ['Auto Moto TV', 'FR'],
  ],
  actualites: [
    ['Info 24', 'FR'],
    ['Afrique 7', 'CI'],
    ['Sen Info', 'SN'],
    ['Presse TV', 'CM'],
    ['Monde Actu', 'FR'],
    ['Finance Live', 'GB'],
    ['Météo & Climat', 'FR'],
    ['Parlement TV', 'FR'],
    ['Santé TV', 'FR'],
    ['Politique Direct', 'FR'],
  ],
  'cinema-series': [
    ['Ciné Première', 'FR'],
    ['Séries Max', 'FR'],
    ['Nollywood Plus', 'NG'],
    ['Film Africa', 'SN'],
    ['Action Channel', 'US'],
    ['Comédie Club', 'FR'],
    ['Horreur TV', 'FR'],
    ['Classiques Or', 'FR'],
    ['Animation Film', 'FR'],
    ['Kino Afrique', 'MA'],
  ],
  documentaires: [
    ['Nature Découverte', 'FR'],
    ['Histoire TV', 'FR'],
    ['Science 360', 'FR'],
    ['Océan & Espace', 'FR'],
    ['Terre Afrique', 'CI'],
    ['Enquête TV', 'FR'],
    ['Tech Report', 'US'],
    ['Gastronomie Doc', 'FR'],
    ['Voyages Lointains', 'FR'],
    ['Civilisations', 'FR'],
  ],
  musique: [
    ['Clip Zone', 'FR'],
    ['Rythmes Afro', 'CI'],
    ['Jazz & Soul', 'US'],
    ['Classique Live', 'FR'],
    ['Rap Français TV', 'FR'],
    ['Kora Music', 'SN'],
    ['Rock Anthology', 'GB'],
    ['Electro Night', 'FR'],
    ['Gospel TV', 'US'],
    ['Variétés Mag', 'MA'],
  ],
  enfants: [
    ['Kidz Land', 'FR'],
    ['Dessins Rires', 'FR'],
    ['Junior Club', 'CI'],
    ['Pti Mousse', 'SN'],
    ['Aventure Kids', 'FR'],
    ['Apprendre en Jouant', 'FR'],
    ['Super Toons', 'MA'],
    ['Contes d’Afrique', 'CM'],
    ['Science Kids', 'FR'],
    ['Jeux & Famille', 'FR'],
  ],
  divertissement: [
    ['Fun One', 'FR'],
    ['Télé Réalité 24', 'FR'],
    ['Rire Ensemble', 'CI'],
    ['Quiz Max', 'FR'],
    ['Diverto Plus', 'MA'],
    ['Cuisine & Partage', 'FR'],
    ['Décoration TV', 'FR'],
    ['Talk Show Afrique', 'SN'],
    ['Jeux Sans Fin', 'FR'],
    ['Spectacle Live', 'FR'],
  ],
  international: [
    ['World News', 'US'],
    ['BBC World', 'GB'],
    ['Al Jazeera', 'QA'],
    ['Deutsche Welle', 'DE'],
    ['TV5 Monde', 'FR'],
    ['Rai News', 'IT'],
    ['RT News', 'RU'],
    ['CGTN', 'CN'],
    ['NHK World', 'JP'],
    ['France 24', 'FR'],
  ],
};

const PROGRAMME_TITLES: Record<string, string[]> = {
  sport: ['Match de la soirée', 'Résumé du championnat', 'Débat d’avant-match', 'Entraînement exclusif', 'Classements et analyses', 'Le grand direct'],
  actualites: ['Journal de 12h', 'Le grand débat', 'Météo nationale', 'Économie en direct', 'Focus régions', 'Le 20h en continu'],
  'cinema-series': ['Film du soir', 'Série à suivre', 'Première diffusion', 'Marathon séries', 'Court métrage', 'Documentaire cinéma'],
  documentaires: ['Planète sauvage', 'Les grandes énigmes', 'Technologies du futur', 'Trésors de l’histoire', 'Cuisine du monde', 'Dans les coulisses'],
  musique: ['Clips à la demande', 'Concert live', 'Top des hits', 'Session acoustique', 'DJ Mix', 'Backstage'],
  enfants: ['Dessin animé matin', 'Aventures de Bibi', 'Colorie avec nous', 'Les petits curieux', 'Histoires du soir', 'Jeu des formes'],
  divertissement: ['Le grand jeu', 'Émission de rires', 'Télé-crochet', 'Quiz des familles', 'Talk show du jour', 'Magazine découvertes'],
  international: ['World Report', 'Business Hour', 'Global News', 'Culture Express', 'Sports World', 'Weather Update'],
};

const DESCRIPTIONS = [
  'Émission en direct, édition du jour.',
  'Sélection des meilleurs moments de la semaine.',
  'Rendez-vous quotidien avec invités et analyses.',
  'Rediffusion de l’émission primée.',
  'Nouvelle saison — épisode inédit.',
  'Magazine de reportages et d’enquêtes.',
];

const MATCHES: Array<[sport: string, competition: string, homeTeam: string, awayTeam: string, hour: number, state: string]> = [
  ['Football', 'Ligue 1', 'Paris SG', 'Marseille', 21, 'SCHEDULED'],
  ['Football', 'Ligue 1', 'Lyon', 'Monaco', 17, 'FINISHED'],
  ['Football', 'Premier League', 'Arsenal', 'Chelsea', 16, 'FINISHED'],
  ['Football', 'Premier League', 'Liverpool', 'Manchester City', 18, 'LIVE'],
  ['Football', 'Serie A', 'Inter', 'Juventus', 20, 'SCHEDULED'],
  ['Football', 'LaLiga', 'Real Madrid', 'Barcelone', 21, 'SCHEDULED'],
  ['Football', 'Ligue des Champions', 'Bayern', 'Benfica', 20, 'SCHEDULED'],
  ['Football', 'CAN Qualifs', 'Côte d’Ivoire', 'Nigéria', 19, 'SCHEDULED'],
  ['Football', 'CAN Qualifs', 'Sénégal', 'Cameroun', 21, 'SCHEDULED'],
  ['Football', 'CAN Qualifs', 'Maroc', 'Algérie', 18, 'LIVE'],
  ['Football', 'Bundesliga', 'Dortmund', 'Leipzig', 15, 'FINISHED'],
  ['Basketball', 'NBA', 'Lakers', 'Celtics', 2, 'LIVE'],
  ['Basketball', 'NBA', 'Bulls', 'Heat', 1, 'FINISHED'],
  ['Basketball', 'EuroLeague', 'Real Madrid', 'Olympiakos', 20, 'SCHEDULED'],
  ['Basketball', 'EuroLeague', 'Panathinaikos', 'Fenerbahçe', 19, 'SCHEDULED'],
  ['Tennis', 'ATP Masters', 'Alcaraz', 'Sinner', 14, 'FINISHED'],
  ['Tennis', 'WTA Tour', 'Swiatek', 'Sabalenka', 16, 'LIVE'],
  ['Rugby', 'Top 14', 'Toulouse', 'La Rochelle', 21, 'SCHEDULED'],
  ['Rugby', 'Top 14', 'Racing 92', 'Clermont', 20, 'SCHEDULED'],
  ['Cyclisme', 'Tour de France', 'Étape 12', 'Arrivée en montagne', 13, 'SCHEDULED'],
];

function dayStart(date: Date): Date {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  return start;
}

function isoMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

function slugify(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

async function seedCategories(): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const category of CATEGORIES) {
    const record = await prisma.category.upsert({
      where: { slug: category.slug },
      update: { name: category.name },
      create: { slug: category.slug, name: category.name },
    });
    ids.set(category.slug, record.id);
  }
  return ids;
}

async function seedChannels(categoryIds: Map<string, string>): Promise<string[]> {
  const channelIds: string[] = [];
  for (const [categorySlug, channels] of Object.entries(CHANNELS_BY_CATEGORY)) {
    for (const [name, country] of channels) {
      const record = await prisma.channel.upsert({
        where: { normalizedKey: slugify(name) },
        update: { canonicalName: name, country, categoryId: categoryIds.get(categorySlug) },
        create: {
          canonicalName: name,
          normalizedKey: slugify(name),
          name,
          country,
          categoryId: categoryIds.get(categorySlug),
        },
      });
      channelIds.push(record.id);
    }
  }
  return channelIds;
}

async function seedProgrammes(channelIds: string[]): Promise<void> {
  await prisma.epgProgramme.deleteMany({});
  const today = dayStart(new Date());
  const end = isoMinutes(today, 24 * 60);

  for (const [index, channelId] of channelIds.entries()) {
    const categorySlug = Object.keys(CHANNELS_BY_CATEGORY)[
      index % Object.keys(CHANNELS_BY_CATEGORY).length
    ];
    const titles = PROGRAMME_TITLES[categorySlug];

    let cursor = isoMinutes(today, 6 * 60);
    let programmeIndex = 0;
    while (cursor.getTime() < end.getTime()) {
      const duration = 30 + ((index + programmeIndex * 7) % 4) * 30;
      const startsAt = cursor;
      const endsAt = isoMinutes(cursor, duration);
      if (endsAt.getTime() > end.getTime()) break;

      await prisma.epgProgramme.create({
        data: {
          channelId,
          startsAt,
          endsAt,
          title: titles[programmeIndex % titles.length],
          description: DESCRIPTIONS[(programmeIndex + index) % DESCRIPTIONS.length],
        },
      });
      cursor = endsAt;
      programmeIndex += 1;
    }
  }
}

async function seedMatches(): Promise<void> {
  await prisma.match.deleteMany({});
  const today = dayStart(new Date());
  for (const [sport, competition, homeTeam, awayTeam, hour, state] of MATCHES) {
    const startsAt = isoMinutes(today, hour * 60);
    await prisma.match.create({
      data: {
        sport,
        competition,
        homeTeam,
        awayTeam,
        startsAt,
        state,
      },
    });
  }
}

async function main(): Promise<void> {
  const categoryIds = await seedCategories();
  const channelIds = await seedChannels(categoryIds);
  await seedProgrammes(channelIds);
  await seedMatches();

  const [categories, channels, programmes, matches] = await Promise.all([
    prisma.category.count(),
    prisma.channel.count(),
    prisma.epgProgramme.count(),
    prisma.match.count(),
  ]);
  console.info(
    `Seed terminé : ${categories} catégories, ${channels} chaînes, ${programmes} programmes, ${matches} matches.`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
