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
| API | `MESH_ENABLED` absent → `/play` byte-identique (réponse sans `p2p`) | déploiement API **séparé** `mbolo-tv-api-meshtest` : `MESH_ENABLED=1` + `MESH_ENFORCE_ALLOWLIST=1` + `MESH_SOURCE_ALLOWLIST=<source-éco-test>` (JAMAIS `*`) + `MESH_TESTER_ALLOWLIST=<testeurs>` (JAMAIS `*`) |
| Mesh worker | inchangé (ou kill) | même worker (isolation par swarmId HMAC) ; `MESH_KILL_SWITCH` opéré ici |
| Testeurs | aucun jeton | `localStorage mbolo:mesh-cap=normal` posé MANUELLEMENT sur les seeders désignés |

`MESH_TESTER_ALLOWLIST` (`workers/mbolo-tv-api/src/mesh.js`) : CSV de
deviceIds bruts **ou** `sha256Hex(deviceId)` (64 hex, préféré : aucun
identifiant brut stocké). Absent = aucune restriction (compat historique) ;
renseigné = seuls les listés reçoivent un jeton, les autres `{ p2p:false }`
**silencieux** (streaming strictement classique, jamais d'erreur `/play`).
`*` = ouvert explicite (tests automatisés uniquement, INTERDIT en canary réel).
`MESH_ENFORCE_ALLOWLIST=1` (**obligatoire sur l'API canary**) : fail closed —
liste absente/vide/`*` = AUCUN jeton émis. Une mauvaise configuration coupe le
P2P au lieu de l'ouvrir. Tests : `workers/mbolo-tv-api/test/mesh-canary.test.mjs`.

### Ajouter un testeur (opérateur, 2 minutes)

1. Récupérer son `deviceId` (celui déjà connu du système : en-tête
   `x-device-id` de l'app, console owner/support — ne jamais demander autre
   chose : ni nom, ni email, ni rien de personnel).
2. Préférence hash (recommandé) : `echo -n "<deviceId>" | sha256sum`
   → 64 hex. Sinon deviceId brut (fonctionne, moins discret).
3. Ajouter l'entrée au secret de l'API **de test** (jamais la prod) :
   `wrangler secret put MESH_TESTER_ALLOWLIST` (valeur CSV complète mise à
   jour, ex. `hash1,hash2`) — redéploiement inutile (secret lu à chaque `/play`).
4. Vérifier : le testeur lance la chaîne de test → `/play` renvoie `p2p:true`
   (console réseau) ; un appareil NON listé sur la même chaîne reçoit
   `p2p:false` et lit normalement (contrôle négatif systématique).
5. Progression 2 → 3 → 5 → 10 : **un ajout à la fois, rapport
   `DECISION_CANARY` entre chaque palier**, jamais d'ajout groupé aveugle.

### Enlever un testeur (retrait immédiat, sans redéploiement)

1. Retirer son entrée de `MESH_TESTER_ALLOWLIST` (`wrangler secret put` avec
   le CSV réduit). Effet dès les prochains `/play` (plus aucun jeton).
2. Option immédiate : `MESH_KILL_SWITCH=1` (coupe tout le P2P en 30-60 s),
   puis retrait de la liste, puis réouverture.
3. Les sessions existantes du testeur retiré s'éteignent par TTL / re-JOIN
   refusé ; sa lecture continue en origin. Aucune donnée à purger côté
   serveur (jetons éphémères, `did` à rotation quotidienne).

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
**comportement différent chez les utilisateurs non autorisés** (tout écart au
streaming classique hors canary = STOP) · fuite token/IP/URL dans la
télémétrie (le `mesh-capture` rejette + le rapport l'exige en § fuites).
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
