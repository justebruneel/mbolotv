# Mbolo TV

Plateforme IPTV multi-sources. Mbolo TV **n’héberge ni ne fournit de flux**. Les sources sont administrées exclusivement par le propriétaire depuis une console sécurisée ; les utilisateurs finaux ne peuvent ni les voir ni les connecter.

## Architecture retenue

Monorepo TypeScript avec séparation claire entre l’expérience web, l’API métier et le traitement asynchrone des playlists. **Aucun Docker ni aucune infrastructure locale requise.**

| Composant | Rôle | Technologie |
|---|---|---|
| `apps/web` | Interface utilisateur et lecteur | Next.js / React, TypeScript |
| `apps/api` | API REST, authentification, règles métier | NestJS, TypeScript |
| `apps/worker` | Import, parsing, déduplication, EPG, indexation | Node.js, BullMQ |
| Base de données | Catalogue et données relationnelles | SQLite (dev) via Prisma — Postgres possible en prod |
| Files d’attente | Jobs d’import et d’EPG | In-process (dev) — BullMQ + Upstash Redis (prod) |
| Stockage | Logos, EPG bruts, exports | Disque local (dev) — S3 / Cloudflare R2 (prod) |

Voir [`docs/architecture/overview.md`](docs/architecture/overview.md) pour les flux et [`docs/architecture/tree.md`](docs/architecture/tree.md) pour l’arborescence détaillée.

## Démarrage local — sans Docker

```bash
cp .env.example .env
pnpm install
pnpm db:migrate   # crée la base SQLite (prisma/dev.db)
pnpm dev          # web (http://localhost:3000) + api (http://localhost:4000)
```

## Hébergement en production

Deux trajectoires, toutes deux sans Docker :

1. **Tout-en-un sur un VPS** — l’app, l’API et le worker sur un même serveur, SQLite en base avec sauvegardes via [Litestream](https://litestream.io). Zéro service managé.
2. **Services managés** — Postgres (Neon ou Supabase), Redis (Upstash), stockage S3 (Cloudflare R2). Avec Prisma, la bascule SQLite → Postgres se limite à changer le `provider` du schéma et le `DATABASE_URL`.

Lors de la mise en production : `STORAGE_DRIVER=s3`, `QUEUE_DRIVER=bullmq`, secrets réels, et `OWNER_CONSOLE_PATH` privé.

## Principes non négociables

- Aucun identifiant Xtream ou MAC n’est retourné au navigateur ni journalisé.
- Les secrets de sources sont chiffrés au repos avec une clé applicative gérée hors Git.
- La console propriétaire est protégée côté serveur par rôle `OWNER` et MFA, pas seulement par une URL discrète.
- Les imports sont asynchrones et idempotents ; aucun parsing lourd dans une requête HTTP.
- Le lecteur récupère un jeton court signé, jamais l’URL fournisseur stockée.
- Toutes les opérations d’administration sont auditées.
