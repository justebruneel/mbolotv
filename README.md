# Mbolo TV

Plateforme IPTV multi-sources pour des flux dont l’utilisation est autorisée. Mbolo TV n’héberge ni ne fournit de flux : les sources sont administrées depuis une console propriétaire et leurs secrets ne sont jamais envoyés au navigateur.

## Architecture

Monorepo TypeScript. **Le backend de production est le Cloudflare Worker `workers/mbolo-tv-api`** ; `apps/api` (NestJS) est du code de référence gelé, non déployé — voir [ADR-0002](docs/adr/0002-backend-unique-cloudflare-worker.md).

| Composant | Rôle | Technologie | Statut |
|---|---|---|---|
| `apps/web` | Interface utilisateur et lecteur HLS | Next.js, React, TypeScript | Production (Vercel) |
| `workers/mbolo-tv-api` | API métier complète : catalogue, accès, favoris, notifications, console owner, imports, crons | Cloudflare Workers, Hyperdrive | **Backend officiel** |
| `workers/mbolo-tv-video-proxy` | Proxy HLS edge, URLs signées HMAC, cache segments, relais | Cloudflare Workers, Durable Objects | Production |
| `apps/api` | Implémentation historique de l'API | NestJS, Fastify, Prisma | Gelé — référence + tests, hors chemin de production |
| `packages/contracts` | Schémas Zod et types partagés des réponses API | TypeScript | Web + API + Worker (validations) |
| Base de données | Catalogue et données relationnelles | PostgreSQL (Neon), schéma Prisma dans `packages/db` | Production |
| Stockage | Playlists et logos | S3/R2 avec URLs signées | Production |

Voir `docs/architecture/overview.md` et `docs/architecture/tree.md` pour les détails.

## Démarrage local

```bash
cp .env.example .env
pnpm install
pnpm db:migrate
pnpm dev
```

Web : `http://localhost:3000`. L’API NestJS de référence (`apps/api`) tourne sur `http://localhost:4000` ; en local comme en production, `apps/web` peut être pointé vers le Worker via `NEXT_PUBLIC_API_URL`.

Le compte propriétaire nécessite `OWNER_EMAIL` et `OWNER_PASSWORD`. Le mot de passe n’est provisionné que si aucun hash propriétaire n’existe déjà, afin d’éviter de réinitialiser la console à chaque redémarrage.

## Production

Le backend de production est `workers/mbolo-tv-api` (Cloudflare Workers + Hyperdrive vers PostgreSQL Neon), déployé manuellement via `npx wrangler deploy`. Le companion edge vidéo `workers/mbolo-tv-video-proxy` signe et proxifie les flux HLS. Le frontend `apps/web` est déployé sur Vercel avec `API_URL` pointant vers le Worker.

`apps/api` (NestJS) n’est **pas le chemin de production** et ne doit plus recevoir de modifications fonctionnelles (gel acté par [ADR-0002](docs/adr/0002-backend-unique-cloudflare-worker.md)) ; sa source de vérité de modèle de données, le schéma Prisma, a été extraite vers `packages/db`. L'instance conteneurisée `mbolotv-api-1` et son script de redéploiement ont été décommissionnés (2026-09-10).

## Principes de sécurité

- Aucun identifiant Xtream, MAC ou URL fournisseur brute n’est retourné au navigateur.
- Les secrets de sources sont chiffrés au repos et les URLs de lecture sont temporaires.
- Les accès owner, imports, audits et statistiques sont filtrés par propriétaire.
- Les URLs externes passent par une validation SSRF, y compris les redirections et les adresses IPv6 privées.
- Les imports sont asynchrones, bornés et idempotents autant que possible.
- Le proxy HLS réécrit les playlists et stream les segments avec backpressure.
- La console utilise une session httpOnly signée, avec expiration d’inactivité et plafond absolu. La MFA n’est pas implémentée dans cette version, ne pas la présenter comme une protection active.
- Les opérations d’administration sont auditées.
