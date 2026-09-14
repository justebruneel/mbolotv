# MeshStream — Canary privé + kill-switch (étape 6, exploitation)

**Principe : production classique P2P OFF · testeurs canary P2P ON ·
kill-switch global P2P OFF immédiat.** Le streaming origin ne dépend jamais du
mesh : toute anomalie mesh donne `{ p2p:false }` ou `pause()`, jamais une erreur
de lecture. Ne pas toucher : video-proxy, relais, SegmentCoordinator, auth,
Postgres, DNS, Service Worker, chemin de lecture classique.

## 1. Séparation des environnements

| Couche | Production classique | Canary (test) |
|---|---|---|
| Front | build prod **sans** `NEXT_PUBLIC_MESH_POC` (chunk mesh jamais chargé, aucun WebRTC/WS/IndexedDB mesh) | preview Vercel **séparé** avec `NEXT_PUBLIC_MESH_POC=1` + `NEXT_PUBLIC_API_URL=<api-meshtest>` |
| API | `MESH_ENABLED` absent → `/play` byte-identique (réponse sans `p2p`) | déploiement API **séparé** `mbolo-tv-api-meshtest` : `MESH_ENABLED=1` + `MESH_SOURCE_ALLOWLIST=<source-éco-test>` (JAMAIS `*`) + `MESH_TESTER_ALLOWLIST=<testeurs>` (JAMAIS `*`) |
| Mesh worker | inchangé (ou kill) | même worker (isolation par swarmId HMAC) ; `MESH_KILL_SWITCH` opéré ici |
| Testeurs | aucun jeton | `localStorage mbolo:mesh-cap=normal` posé MANUELLEMENT sur les seeders désignés |

`MESH_TESTER_ALLOWLIST` (nouveau, `workers/mbolo-tv-api/src/mesh.js`) : CSV de
deviceIds bruts **ou** `sha256Hex(deviceId)` (64 hex, préféré). Absent = aucune
restriction (compat) ; renseigné = seuls les listés reçoivent un jeton, les
autres `{ p2p:false }`. `*` = ouvert explicite (tests automatisés uniquement,
INTERDIT en canary réel). Tests : `workers/mbolo-tv-api/test/mesh-canary.test.mjs`.

## 2. Kill-switch (déjà implémenté, à tester AVANT le canary)

- Serveur : `MESH_KILL_SWITCH=1` → `meshConfigFromEnv().p2pEnabled=false` →
  `CONFIG{p2pEnabled:false}` poussé aux membres (alarme DO ≤ 30-60 s).
- Client (`MeshClient`) : `pause()` — plus de demandes, plus de fenêtre publiée,
  liens fermés proprement, socket gardée pour le `CONFIG` de reprise ; le loader
  devient passe-through origin. Reprise : `resume()` = re-JOIN idempotent,
  nouveaux `peerHits`, **sans recharger la page**.
- Front : sans `p2p:true`, `createMeshBridge` rend `{ session:null }` et le
  chunk `@mbolo/mesh` n'est jamais importé (garde build + jeton + capabilities).

### Scénario de validation (10 étapes, STOP si une échoue)

1. Mesh ON (kill absent), 2 testeurs en lecture, `peerHits > 0` constaté côté
   consommateur. 2) Poser le kill : `printf '1' | wrangler secret put
   MESH_KILL_SWITCH` (worker mesh). 3) Sous 30-60 s, les deux consoles loguent
   `{t:'kill',enabled:false}` (préfixe `[mesh-test]`). 4) Nouvelles demandes P2P
   refusées (`selected`/`peerResult` cessent). 5) Sessions existantes en pause
   propre (`dc close` + `dcStats`, pas d'exception). 6) Lecture origin continue
   (tiers `origin`, aucun stall imposé par le mesh). 7) Aucune coupure vidéo.
   8) Rouvrir : `wrangler secret delete MESH_KILL_SWITCH` (+ `secret list`
   pour valider la suppression). 9) Re-JOIN automatique (`{t:'kill',
   enabled:true}` + `session`/`peers`). 10) Reprise P2P (`peerHits` repart)
   **sans rechargement**.
9) Si une étape échoue → STOP avant le canary (bug à corriger, logs conservés,
   rapport `mesh-report` joint).

## 3. Vérifications anti-régression (avant chaque activation canary)

```
pnpm test && pnpm typecheck && pnpm lint && pnpm --filter @mbolo/web build
```

Puis, **sans activation MeshStream** (build prod, `MESH_ENABLED` absent) :
chunk mesh non chargé · aucun `RTCPeerConnection` créé · aucun WebSocket mesh ·
aucun IndexedDB mesh · `/play` identique (`mesh-play.test.mjs` le fige) ·
streaming origin inchangé. En cas d'écart : STOP.

## 4. STOP CONDITIONS → conduite

Symptômes : stall > 5 s · erreurs lecture en hausse · fallback origin cassé ·
boucle WebRTC · CPU/réseau/mémoire anormaux · crash · P2P non désactivable ·
fuite token/IP/URL dans la télémétrie (le `mesh-capture` rejette + le rapport
l'exige en § fuites).
Conduite : 1) kill-switch 2) canary OFF 3) conserver logs/onglets 4) exporter
dumps 5) `mesh-report` 6) aucune extension du groupe.

## 5. Télémétrie : pourquoi pas d'endpoint serveur à ce stade

Choix assumé : **export JSON local** (`window.__meshTest.dump()` → fichiers →
`scripts/mesh-capture.mjs` → `mesh-test-runs/<run-id>.json` → `scripts/mesh-report.mjs`).
Aucun endpoint de télémétrie, aucune table, aucun tracking utilisateur. Un futur
endpoint dédié (séparé du datapath vidéo, payload Zod strict, taille max, rate
limit, sans données personnelles/contenu/URL) ne sera proposé qu'après un canary
local concluant — pas avant.

## 6. Références

- Runbook deux-appareils : `docs/operations/meshstream-step6-validation.md`
- Protocole testeurs : `docs/operations/meshstream-step6-human-test.md`
- Rapport canary : `docs/operations/meshstream-step6-canary-report.md`
- Exemples : `mesh-test-runs/run-example-*-mock.json` + `report-example.md`
  (provenance `mock` = format de référence, JAMAIS une preuve réelle).
