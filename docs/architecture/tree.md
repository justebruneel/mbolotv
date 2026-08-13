# Arborescence cible

```text
mbolo-tv/
├── apps/
│   ├── web/                         # application Next.js utilisateur
│   │   └── src/
│   │       ├── app/                 # routes, layouts, middleware
│   │       ├── features/            # domaines UI isolés
│   │       │   ├── live-tv/         # catalogue, filtre, favoris, player
│   │       │   ├── matches/         # calendrier, live, sélection serveur
│   │       │   ├── sources/         # formulaires M3U/Xtream/MAC
│   │       │   └── ...
│   │       └── shared/              # composants, client API, hooks
│   ├── api/                         # API NestJS
│   │   └── src/modules/             # un module par domaine métier
│   └── worker/                      # consumers BullMQ / parsers
├── packages/
│   ├── contracts/                   # DTO, schemas Zod et événements partagés
│   ├── ui/                          # design system sans logique métier
│   └── config/                      # TS/ESLint/Prettier partagés
├── infra/                           # reverse proxy, observabilité, Docker
├── docs/                            # ADR, API, runbooks, architecture
├── tests/                           # e2e et intégration transverses
└── scripts/                         # migrations, seed, maintenance
```
