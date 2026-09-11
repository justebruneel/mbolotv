# ADR-0003 — Port des tests de référence de apps/api vers le Worker (Phase 3)

**Date :** 2026-09-11
**Statut :** Acceptée
**Contexte :** suite de l'ADR-0002 (backend unique Cloudflare Worker). Les 22
suites Jest de `apps/api` (126 tests) étaient le dernier élément qui rendait
la suppression de `apps/api` risquée.

## Principe

On ne « traduit » pas les tests Prisma/DI NestJS un à un : on porte les
**règles métier** qu'ils matérialisent, sous `node --test`
(`workers/mbolo-tv-api/test/*.test.mjs`), contre les implémentations Worker.
Trois modes, par ordre de préférence :

1. **Test direct** — la fonction pure existe côté Worker (m3u, xmltv,
   parseMatchTitle, isPrivateHostname, channelKey) : les cas de la référence
   sont repris tels quels.
2. **Test de spécification** — la logique est du SQL intégré à une route
   (empilement d'accès, cycle de vie des matchs, politique CORS) : le test
   documente et fige la règle (constantes, format, invariants) ; toute
   modification du code doit passer par la mise à jour du test.
3. **Couverture par contrats** — les validations d'entrée (routes owner et
   publiques pipées dans la référence) sont déjà couvertes par
   `contracts.test.mjs` (Phase 2).

## Suites portées (mode 1 et 2)

| Suite Worker | Origine apps/api | Tests |
|---|---|---|
| `m3u.test.mjs` | m3u.parser (dossiers, conteneurs, VOD, #EXTGRP, limite) | 10 |
| `discovery.test.mjs` | matches-discovery (parseMatchTitle + règles de cycle de vie) | 13 |
| `xmltv.test.mjs` | xmltv.parser (entités, offsets, programmes incomplets) | 3 |
| `ssrf.test.mjs` | ssrf/safe-fetcher (IP privées, hosts internes) | 4 |
| `access-expiry.test.mjs` | access.service (empilement des durées de code) | 5 |
| `epg-mapping.test.mjs` | epg-import (tolérance des clés de mapping) | 8 |
| `cors-policy.test.mjs` | cors (politique portée de resolveCors) | 6 |

## Suites volontairement NON portées (et pourquoi)

- **streaming/* (26 tests)** — le module testé n'existe plus : le proxy edge
  `mbolo-tv-video-proxy` a remplacé hls-rewriter/stream-proxy/caches avec une
  architecture différente (signatures HMAC + single-flight Durable Objects au
  lieu d'alias Redis-less). Les tests Nest testaient une implémentation morte.
- **vod-favorites / external-favorites (20)** — la logique est désormais une
  requête SQL unique éprouvée en production (ON CONFLICT, filtres
  isActive/isVisible) ; le mur DeviceGrant est couvert par les smoke tests de
  déploiement. Portage = photographier du SQL, aucune règle à figer.
- **connectors / xtream-vod / sources.service / tvmaze (23)** — pipeline
  d'import réécrit (importer.js) ; les règles divergentes significatives sont
  couvertes par les contrats et les crons réels.
- **Tests de DI/mocks Prisma** — sans objet hors NestJS.

## Conséquences

- `apps/api` n'est plus porteur d'aucun test de référence : la suppression
  (tag `archive/nestjs-api` d'abord) ne détruit plus de couverture.
- Les tests Worker (104 + 49 portés = 153) tournent sous `node --test`, sans
  dépendance au workspace pnpm.
- **Durcissement SSRF noté** : l'import Worker ne résout pas le DNS
  (`isPrivateHostname` est littéral) — surface acceptée car les URLs de
  sources sont configurées par l'owner uniquement (cf. ADR-0002). Une
  extension future de l'import vers des URLs utilisateur devrait réintroduire
  une résolution DNS.
