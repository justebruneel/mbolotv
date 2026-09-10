# ADR-0002 — Backend unique Cloudflare Worker ; suppression progressive de apps/api

**Date :** 2026-09-10
**Statut :** Acceptée
**Contexte :** audit de maintenabilité §3.3 (duplication NestJS / Cloudflare Workers).

## Contexte

Le dépôt contient deux implémentations complètes de l'API métier :

- `apps/api` (NestJS + Prisma, ~8 900 lignes TS) — **pas de déploiement CI** (aucun Dockerfile, aucun workflow, `infra/` vide) ; subsiste une instance conteneurisée entretenue manuellement (`scripts/deploy-api.sh`, dernière maintenance 2026-09-09) à décommissionner ;
- `workers/mbolo-tv-api` (Cloudflare Workers + Hyperdrive/Postgres, ~10 400 lignes JS) — **backend de production réel** : c'est son URL que consomment `apps/web` (Vercel), le middleware owner et les enveloppes Android ; le worker `mbolo-tv-video-proxy` est son companion edge vidéo.

Chaque route publique et owner existe dans les deux implémentations, avec des couches basses dupliquées (crypto AES-GCM, JWT, slugify, détection de pays, CORS) et des forks contraints par le runtime (Argon2 impossible sous Workers → PBKDF2). Ce risque de divergence est noté **critique pour la maintenabilité**.

L'option « deux backends assumés » (contrats générés + tests de compatibilité) a été évaluée et rejetée : son coût ne se justifie que s'il existe une raison structurelle de maintenir les deux, ce qui n'est pas le cas — NestJS ne porte aucune fonctionnalité absente du Worker (il en porte même moins : extractors, scrapers, bot externe, YouTube, eco adaptatif et relay n'existent que côté Worker).

## Décision

**Option A — Worker unique**, appliquée progressivement :

1. `workers/mbolo-tv-api` est **le** backend officiel. Toute évolution fonctionnelle d'API se fait dans le Worker.
2. `apps/api` est **gelé immédiatement** : aucune modification fonctionnelle n'y est acceptée. Il ne survit que comme référence de lecture et réservoir de tests.
3. Deux éléments de `apps/api` sont **structurellement nécessaires** et doivent lui survivre avant toute suppression :
   - **le schéma Prisma et ses migrations** (source de vérité du modèle de données, y compris pour le SQL brut du Worker) → extraits vers `packages/db` ;
   - **les tests Jest de référence** (règles métier auth/accès/favorites, etc.) → portés sur le Worker.
4. `@mbolo/contracts` (schémas Zod partagés) doit être consommé par le Worker pour supprimer la divergence de validation des entrées — les routes owner d'abord.
5. Une fois 3 et 4 terminés, `apps/api` est supprimé du `main` (après tag `archive/nestjs-api` pour conservation), et avec lui le script de déploiement conteneur `scripts/deploy-api.sh` — après confirmation que l'instance `mbolotv-api-1` ne sert plus aucun client.

## Conséquences

- **Positif** : un seul chemin de code à corriger ; plus de bugs « corrigés deux fois » ni de réponses JSON divergentes ; les contrats Zod redeviennent l'unique source de vérité des validations, partagée Worker/Web.
- **Négatif / à surveiller** : la référence NestJS disparaît une fois `apps/api` supprimé (compensé par le tag git) ; les tests portés doivent être réécrits sans la DI NestJS ; le hash PBKDF2 du Worker reste un fork assumé d'Argon2 — les comptes propriétaires provisionnés côté NestJS devront être re-hashés côté Worker avant suppression.
- **Règle de revue** : tout PR touchant un module dupliqué (auth, accès, favorites, owner console…) doit cibler le Worker ; un PR qui modifie la logique métier dans `apps/api` doit être refusé.

## Séquence d'exécution

| Phase | Contenu | Statut |
|---|---|---|
| 0 | Gel documenté (cet ADR + README) | ✅ fait (2026-09-10) |
| 1 | Extraction `apps/api/prisma/` → `packages/db` | ✅ fait (2026-09-10) — schéma + migrations + seed + client généré (`@mbolo/db`) |
| 2 | Câblage de `@mbolo/contracts` dans le Worker | ⏳ |
| 3 | Port des tests de référence vers le Worker, puis tag + suppression de `apps/api` | ⏳ |

Mise à jour 2026-09-10 : l'instance conteneurisée `mbolotv-api-1` ne servait aucun client (les applications Android et le web pointent tous vers Vercel/Workers) ; `scripts/deploy-api.sh` a été retiré et le décommissionnement validé avant l'extraction de la Phase 1.
