# Rapport MeshStream — phase canary (test contrôlé)

Généré : 2026-09-14T18:59:25.177Z
Runs : run-example-a-b-mock (scénario A) — 2 session(s), 35 événement(s)
Sessions : 2 au total (0 real-device, 2 mock) — seules les real-device comptent ci-dessous.

## REAL_P2P_VIDEO = NOT_VALIDATED
Aucun transfert corrélé req+srv (même tid, ok des deux côtés, octets > 0) observé sur appareils réels.
Critère : deux appareils physiques doivent réellement échanger un segment via DataChannel — NON DÉMONTRÉ à ce stade. Ne pas élargir le trafic.

## WebRTC (appareils réels uniquement)
- Tentatives ICE : 0 · réussies : 0 · échouées : 0 · succès : n/a
- Durée moyenne de connexion (succès) : n/a ms
- Paires host/srflx/relay : aucune paire observée
- DataChannel : open ×0 · close ×0 · error ×0 · HELLO acceptés 0/0 · backpressure ×0

## P2P (appareils réels uniquement)
- Transferts demandés (req) : 0 · réussis : 0 · servis (srv ok) : 0
- Tiers loader : peer ×0 · origin ×0 · memory ×0 · idb ×0
- peerSegments / (peerSegments + originSegments) : n/a (0/0)
- mesh offload peerBytes / (peerBytes + originBytes) : n/a (0 o / 0 o)
- Transferts corrélés A↔B : 0

## Qualité
- Timeouts : 0 · hash failures : 0 · fallbacks : 0 (aucun) · fallback rate : n/a
- Stalls : 0 (total 0 ms, max 0 ms, moy 0 ms) · erreurs lecture : 0
- Événements kill-switch : 0
- Sessions P2P (peerHits > 0) vs origin-only : 0 vs 0 (comparer stalls/erreurs entre les deux groupes avant toute conclusion)

## Résilience
- Aucun repli observé (scénario C « disparition du peer » NON TESTÉ).
- Exigence : peerResult en échec → tier origin sous ≤ timeout (1,5 s défaut), aucun blocage loader, stall > 5 s = STOP.

## TURN DECISION : INSUFFICIENT_DATA
- Tentatives ICE : 0 · succès : 0 · échecs : 0
- Par classe d'appareil : n/a
- Par réseau : n/a
- Paires via relay observées : 0 · échecs : 0
- Volume insuffisant (< 10 tentatives) : NE PAS installer TURN. Ne jamais décider TURN sur 1-2 échecs.

## Statut de preuve (ne jamais mélanger)
- PROUVÉ EN PRODUCTION : signaling, auth, kill-switch, polling, WebSocket (batterie §6 edge + runbook étape 6 — hors captures, voir docs/operations/meshstream-step6-validation.md).
- PROUVÉ PAR MOCK : PeerLink, DataChannel, scoring, loader (tests unitaires : packages/mesh + workers — sans observations réelles ci-dessus).
- PROUVÉ SUR APPAREILS RÉELS : RIEN pour l'instant (aucune corrélation tid req+srv) — seul ce qui est ci-dessus compte.
- NON TESTÉ : résilience disparition du peer · stalls en conditions réelles · matrice CGNAT multi-réseaux · Android/WebView/Android TV (sauf sessions deviceClass correspondantes) · décision TURN (données insuffisantes).

## STOP CONDITIONS (rappel opérateur)
kill-switch + canary OFF immédiats si : stall > 5 s · erreurs lecture en hausse · fallback origin cassé · boucle WebRTC · CPU/réseau/mémoire anormaux · crash · P2P non désactivable · fuite token/IP/URL dans la télémétrie. Conserver les logs, générer ce rapport, ne pas élargir.
