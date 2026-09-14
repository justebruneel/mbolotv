# MeshStream — Rapport final de préparation canary (étape 6, sans appareils réels)

**Date : 2026-09-14. Périmètre : PRÉPARATION du système de test + collecte +
rapport. Aucun test deux-appareils réels exécuté dans cette tâche. Aucun
élargissement du trafic. Ne pas déployer de fonctionnalité publique sur cette
base.**

## Verdict

```
REAL_P2P_VIDEO = NOT_VALIDATED
TURN = INSUFFICIENT_DATA (0 tentative ICE réelle — ne pas installer TURN)
```

Le critère de l'étape (« deux appareils physiques échangent un segment via
DataChannel, démontré quantitativement ») n'est pas rempli : il ne pourra
l'être que par le protocole `meshstream-step6-human-test.md` (scénarios A→F) +
`mesh-capture` + `mesh-report` livrés ici.

## Livrables (cette tâche)

1. **Canary/allowlist** : `MESH_TESTER_ALLOWLIST` dans
   `workers/mbolo-tv-api/src/mesh.js` (deviceId brut ou sha256, `*` interdit en
   canary, refus = `{ p2p:false }`, datapath intact) + tests
   `workers/mbolo-tv-api/test/mesh-canary.test.mjs` (10/10).
2. **`scripts/mesh-capture.mjs`** : valide + normalise les dumps locaux vers
   `mesh-test-runs/<run-id>.json` (1 Mo max, 10 000 événements max, rejet des
   fuites token/IP/URL, promotion mock→real interdite).
3. **`scripts/mesh-report.mjs`** : `node scripts/mesh-report.mjs
   ./mesh-test-runs/*.json` → WebRTC / P2P / qualité / résilience / TURN /
   `REAL_P2P_VIDEO` / statuts de preuve. `--json` disponible.
4. **Endpoint télémétrie : NON CRÉÉ (assumé)** — export local préféré à un
   nouveau stockage/endpoint (pas de tracking général). Réévaluer après canary.
5. **`docs/operations/meshstream-step6-human-test.md`** : protocole testeurs
   (A même Wi-Fi, B réseaux ≠, C disparition, D arrière-plan, E Android/WebView,
   F Android TV) + fiche de relevé + STOP CONDITIONS + montée 2→3→5→10.
6. **Exemples** : `mesh-test-runs/run-example-a-b-mock.json`,
   `run-example-origin-only-mock.json` (provenance `mock` = format, pas preuve)
   + `report-example.md` généré par le script.
7. **Kill-switch** : `docs/operations/meshstream-canary-killswitch.md`
   (scénario 10 étapes, anti-régression, STOP CONDITIONS, rollback).
8. **Instrumentation** : `packages/mesh/src/trace.ts` étendue (session,
   iceResult, dcStats, backpressure, transfer corrélé `tid`=nonce, fallback,
   stall, playError, visibility + collecteur borné 2000 + `findMeshTraceLeak` /
   `assertMeshTracePrivacy` + `classifyDeviceClass`) ; `peer-link.ts`
   (durées ICE, compteurs DC, transferts req/srv), `mesh-client.ts` (fallback
   corrélé), `mesh-session.ts` (`peerLabel`), `apps/web/src/shared/mesh/poc.ts`
   (collecteur + événement session + `window.__meshTest.dump/export/noteStall/
   noteError`) ; tests `packages/mesh/test/mesh-trace-canary.test.mjs` (9/9).
9. **Tests** : mesh 110/110 + trace-canary 9/9 + api-mesh existants + canary
   10/10 (vérification complète `pnpm test / typecheck / lint / build` en § suivant).

## Statut de preuve (honnête)

- **PROUVÉ EN PRODUCTION** : signaling, auth, kill-switch, polling, WebSocket
  (batterie §6 edge 7/7 + runbook `meshstream-step6-validation.md` — antérieur,
  hors captures).
- **PROUVÉ PAR MOCK** : PeerLink, DataChannel, scoring, loader, instrumentation
  (tests unitaires ci-dessus ; transferts simulés A↔B sous mocks).
- **PROUVÉ SUR APPAREILS RÉELS** : RIEN (0 session real-device).
- **NON TESTÉ** : ICE/DC/transferts/offload/résilience réels, stalls réels,
  CGNAT, mobile/WebView/Android TV, TURN, kill-switch à deux appareils connectés
  (procédure prête, exécution requise avant canary).

## Prochaines étapes (opérateur, pas dans cette tâche)

1. Anti-régression (`pnpm test && typecheck && lint && build web`) + vérif
   prod sans mesh (chunk non chargé, aucun WebRTC/WS/IDB, `/play` identique).
2. Scénario kill-switch 10 étapes → STOP si échec.
3. Canary 2 testeurs, scénario A → `mesh-capture` → `mesh-report` → décider.
4. B → C → D (→ E/F si matériel) avec rapports à chaque palier.
5. Ne statuer TURN qu'après ≥ 10 tentatives ICE réelles.
6. S'arrêter après la phase de test (pas d'élargissement automatique).
