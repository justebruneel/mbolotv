# MeshStream v1 — Activation production (2026-09-14)

**Statut : backend PROD actif, frontend en attente d'une variable Vercel.**
Aucune valeur secrète dans ce document (voir gestionnaires : dashboard
Cloudflare / Vercel). Ne jamais committer de secret.

## 1. État production exact

| Élément | Valeur / état |
|---|---|
| Worker mesh | `mbolo-tv-mesh` déployé, `https://mbolo-tv-mesh.mbolo-tv-video-proxy.workers.dev`, `/mesh/health` OK, `_stats.p2pEnabled=true` |
| Secrets mesh worker | `MESH_URL_SECRET` seul (pas de `MESH_KILL_SWITCH`) |
| API `mbolo-tv-api` | redéployée avec code actuel ; secrets `MESH_ENABLED=1`, `MESH_PUBLIC_URL` (= URL mesh ci-dessus), `MESH_SOURCE_ALLOWLIST` (= 1 source, voir §2), `MESH_URL_SECRET` **identique** au mesh worker |
| Secrets ABSENTS (vérifié) | `MESH_TESTER_ALLOWLIST`, `MESH_ENFORCE_ALLOWLIST` (prod ouverte aux utilisateurs des sources autorisées), `MESH_KILL_SWITCH` |
| Batterie edge | `mesh-remote-check.mjs` : **7/7 OK en production** |
| Kill-switch live | testé : ON → `p2pEnabled:false`, OFF → `true`, secret supprimé après test |
| DB | 1 source (voir §2), 11 915 variantes actives ; import en cours (`IMPORTING`), health majoritairement non sondé — le mesh ne fait que suivre la lecture qui marche (fallback origin sinon) |
| Frontend prod | **EN ATTENTE** : poser `NEXT_PUBLIC_MESH_ENABLED=1` dans l'env Vercel de production puis redéployer (voir §4). Sans cela, le P2P reste dormant côté client (tokens émis mais ignorés — inoffensif) |

## 2. Allowlist de sources (explicite, jamais `*`)

Récupérée depuis la DB le 2026-09-14 (lecture seule via passerelle) :

```
MESH_SOURCE_ALLOWLIST = 5ba667e5-68ec-42ed-a93a-eb9a102bd859   # "Tv" (XTREAM, seule source)
```

Règle : toute nouvelle source = ajout explicite après vérification de
variantes live saines. `docs/architecture/meshstream.md` §2 (séparation
éco/HD par swarmId) respecté par construction.

## 3. Seeding production (décision opérateur 2026-09-14)

`consentedCapacity()` : défaut `normal` (TV/WebView : `off`), refus explicite
`localStorage mbolo:mesh-cap=off` respecté. Plafonds `effectiveCapacity`
inchangés : arrière-plan → off, saveData → off, cellulaire → low.
**Écart assumé** : la mission initiale interdisait de forcer l'upload ;
l'opérateur a ordonné le seeding adapté permanent. Kill-switch inchangé.

## 4. Reste à faire côté opérateur (sans accès depuis l'atelier)

1. Vercel → projet web prod → Environment Variables :
   `NEXT_PUBLIC_MESH_ENABLED=1` (Production uniquement), sauvegarder.
2. Redéployer le front (push main déjà fait / Rebuild Vercel).
3. Ouvrir la prod sur 2 appareils : lecture normale → `[mesh-test]` actif →
   `peers ≥ 1`, `peerHits > 0` → export dumps → `mesh-capture` + `mesh-report`
   → `REAL_P2P_VIDEO` doit passer VALIDATED sur données réelles.
4. Scénarios prod : changement de qualité, arrière-plan/avant-plan,
   disparition d'un peer, re-JOIN après kill ON/OFF (sans reload).
5. Datapath classique : `/play`, proxy, SegmentCoordinator, relais, mpegts,
   Safari, SW, auth — inchangés (vérifiés §5).

## 5. Vérifications effectuées le 2026-09-14 (atelier)

- Mesh `/mesh/health` OK ; `_stats` : `p2pEnabled:true`, auth admin OK.
- API : `/` 401, `/play` sans grant 401/403/404 classiques, **aucun 500**.
- `mesh-remote-check` 7/7 (JOIN, découverte, cap=off, rid, usurpation ×2, kill).
- Kill-switch live ON/OFF vérifié via `_stats` (délai de propagation ~15 s).
- Sécurité : `MESH_URL_SECRET` absent du code client et du build web ;
  HELLO pair = proto/cap/sid/rid (pas de token) ; IndexedDB = octets + ids
  opaques ; télémétrie anti-fuite testée (`mesh-capture` rejette).
- Limites v1 conservées : maxPeers 4/6, timeout 1,5 s, bufferCritical 12 s,
  liveEdge 2 seg, cooldown 10 min, backpressure 1 Mo, caches bornés,
  messages 8 Ko. STUN uniquement, **pas de TURN**.
- `pnpm test` 235+53 OK · `typecheck` OK · `lint` OK · `build web` OK.

## 6. Rollback (sans redéploiement)

1. `wrangler secret put MESH_KILL_SWITCH --name mbolo-tv-mesh` (= "1") →
   P2P neutre en ≤ 60 s, lecture intacte.
2. `wrangler secret delete MESH_ENABLED --name mbolo-tv-api` → plus aucun
   jeton (si besoin d'un arrêt total).
3. `wrangler rollback` sur chaque worker si un déploiement est en cause.
