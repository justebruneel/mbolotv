# Arborescence

```text
mbolo-tv/
├── apps/
│   └── web/                         # application Next.js utilisateur
│       └── src/
│           ├── app/                 # routes, layouts, middleware
│           ├── features/            # domaines UI isolés
│           │   ├── live-tv/         # catalogue, filtre, favoris, player
│           │   ├── matches/         # calendrier, live, sélection serveur
│           │   ├── sources/         # formulaires M3U/Xtream/MAC
│           │   └── ...
│           └── shared/              # composants, client API, hooks
├── workers/
│   ├── mbolo-tv-api/                # API métier (Cloudflare Worker) : routes,
│   │   └── src/                     # console owner, imports, crons, tests/
│   └── mbolo-tv-video-proxy/        # proxy HLS edge signé (Durable Objects)
├── packages/
│   ├── contracts/                   # DTO, schemas Zod partagés (web + worker)
│   ├── db/                          # schéma Prisma, migrations, seed
│   ├── ui/                          # design system sans logique métier
│   └── config/                      # TS/ESLint/Prettier partagés
├── docs/                            # ADR, API, runbooks, architecture
├── tests/                           # e2e et intégration transverses
└── scripts/                         # maintenance
```

L'API NestJS historique (`apps/api`) a été retirée du dépôt (ADR-0002) ;
l'arborescence d'origine reste visible au tag `archive/nestjs-api`.
