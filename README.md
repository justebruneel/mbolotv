# Mbolo TV

Plateforme IPTV multi-sources pour des flux dont l’utilisation est autorisée. Mbolo TV n’héberge ni ne fournit de flux : les sources sont administrées depuis une console propriétaire et leurs secrets ne sont jamais envoyés au navigateur.

## Architecture

Monorepo TypeScript. **Le backend est le Cloudflare Worker `workers/mbolo-tv-api`** — il n’existe aucune autre implémentation de l’API (l’historique NestJS a été retiré, voir [ADR-0002](docs/adr/0002-backend-unique-cloudflare-worker.md) et le tag `archive/nestjs-api`).

| Composant | Rôle | Technologie | Statut |
|---|---|---|---|
| `apps/web` | Interface utilisateur et lecteur HLS | Next.js, React, TypeScript | Production (Vercel) |
| `workers/mbolo-tv-api` | API métier complète : catalogue, accès, favoris, notifications, console owner, imports, crons | Cloudflare Workers, Hyperdrive | **Backend officiel** |
| `workers/mbolo-tv-video-proxy` | Proxy HLS edge, URLs signées HMAC, cache segments, relais | Cloudflare Workers, Durable Objects | Production |
| `packages/contracts` | Schémas Zod et types partagés des réponses API | TypeScript | Web + Worker (validations) |
| `packages/db` | Modèle de données : schéma Prisma, migrations, seed | Prisma, PostgreSQL | Production (Neon) |
| Stockage | Playlists et logos | S3/R2 avec URLs signées | Production |

Voir `docs/architecture/overview.md` et `docs/architecture/tree.md` pour les détails.

## Démarrage local

```bash
cp .env.example .env
pnpm install
pnpm generate
pnpm db:migrate
pnpm dev
```

Web : `http://localhost:3000`, pointant vers l’API de ton choix via `NEXT_PUBLIC_API_URL` (Worker distant ou `wrangler dev` local).

Le compte propriétaire se provisionne avec `workers/mbolo-tv-api/scripts/bootstrap-owner.mjs "<url-postgres>" "<email>" "<mot-de-passe>"` (PBKDF2, format consommé par le Worker).

## Tests

```bash
pnpm test
```

- Tests Worker (`node --test workers/mbolo-tv-api/test/`) : règles métier portées de la référence historique — m3u, XMLTV, découverte de matchs, SSRF, empilement d’accès, mapping EPG, CORS, contrats partagés [ADR-0003](docs/adr/0003-port-tests-worker.md).
- Tests packages/workspace : jest (web) et typecheck.

## Production

Le backend est `workers/mbolo-tv-api` (Cloudflare Workers + Hyperdrive vers PostgreSQL Neon), déployé via `npx wrangler deploy`. Le companion edge vidéo `workers/mbolo-tv-video-proxy` signe et proxifie les flux HLS. Le frontend `apps/web` est déployé sur Vercel avec `API_URL` pointant vers le Worker.

Les migrations de schéma sont appliquées depuis `packages/db` (`pnpm db:migrate`) ; le Worker consomme le même PostgreSQL via Hyperdrive.

## Principes de sécurité

- Aucun identifiant Xtream, MAC ou URL fournisseur brute n’est retourné au navigateur.
- Les secrets de sources sont chiffrés au repos (AES-GCM) et les URLs de lecture sont temporaires et signées (HMAC).
- Les accès owner, imports, audits et statistiques sont filtrés par propriétaire.
- Les URLs externes passent par une validation SSRF (hosts privés/réservés refusés ; surface limitée à la configuration owner).
- Les imports sont asynchrones, bornés et idempotents autant que possible.
- Le proxy HLS réécrit les playlists, signe chaque URL enfant et met en cache playlists/segments à l’edge.
- La console utilise une session httpOnly signée, avec expiration d’inactivité et plafond absolu. La MFA n’est pas implémentée dans cette version, ne pas la présenter comme une protection active.
- Les opérations d’administration sont auditées.
