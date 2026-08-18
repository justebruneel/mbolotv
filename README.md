# Mbolo TV

Plateforme IPTV multi-sources pour des flux dont l’utilisation est autorisée. Mbolo TV n’héberge ni ne fournit de flux : les sources sont administrées depuis une console propriétaire et leurs secrets ne sont jamais envoyés au navigateur.

## Architecture

Monorepo TypeScript avec séparation entre l’expérience web, l’API métier et le traitement asynchrone.

| Composant | Rôle | Technologie |
|---|---|---|
| `apps/web` | Interface utilisateur et lecteur HLS | Next.js, React, TypeScript |
| `apps/api` | API REST, authentification, import et proxy de lecture | NestJS, Fastify, Prisma |
| `apps/worker` | Point d’extension pour les jobs séparés | Node.js, BullMQ |
| Base de données | Catalogue et données relationnelles | SQLite validé pour dev, migration Postgres à préparer pour prod |
| Files d’attente | Imports et jobs asynchrones | In-process en dev, BullMQ/Redis en déploiement dédié |
| Stockage | Playlists et logos | Disque local en dev, S3/R2 avec URLs signées en prod |

Voir `docs/architecture/overview.md` et `docs/architecture/tree.md` pour les détails.

## Démarrage local

```bash
cp .env.example .env
pnpm install
pnpm db:migrate
pnpm dev
```

Web : `http://localhost:3000`. API : `http://localhost:4000`.

Le compte propriétaire nécessite `OWNER_EMAIL` et `OWNER_PASSWORD`. Le mot de passe n’est provisionné que si aucun hash propriétaire n’existe déjà, afin d’éviter de réinitialiser la console à chaque redémarrage.

## Production

Le chemin recommandé est un déploiement avec Postgres, Redis et S3/R2 managés. Le schéma Prisma est actuellement SQLite et ne doit pas être basculé en production par simple changement d’URL sans migration et validation dédiées.

En mode BullMQ, un consommateur doit être actif. La branche actuelle peut traiter les imports via l’API ; le worker séparé reste une étape de découplage à finaliser avant un déploiement multi-instance.

## Principes de sécurité

- Aucun identifiant Xtream, MAC ou URL fournisseur brute n’est retourné au navigateur.
- Les secrets de sources sont chiffrés au repos et les URLs de lecture sont temporaires.
- Les accès owner, imports, audits et statistiques sont filtrés par propriétaire.
- Les URLs externes passent par une validation SSRF, y compris les redirections et les adresses IPv6 privées.
- Les imports sont asynchrones, bornés et idempotents autant que possible.
- Le proxy HLS réécrit les playlists et stream les segments avec backpressure.
- La console utilise une session httpOnly signée, avec expiration d’inactivité et plafond absolu. La MFA n’est pas implémentée dans cette version, ne pas la présenter comme une protection active.
- Les opérations d’administration sont auditées.
