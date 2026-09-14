# Rapport MeshStream — phase canary (test contrôlé)

Généré : 2026-09-14T19:23:08.030Z
Runs : run-example-a-b-mock (scénario A) — 2 session(s), 35 événement(s)
Sessions : 2 au total (0 real-device, 2 mock) — seules les real-device comptent ci-dessous.

## REAL_P2P_VIDEO = NOT_VALIDATED
Aucune preuve complète (req+srv, même tid/swarm/segment, octets > 0, DC ouvert bilatéral) sur appareils réels.
Critère : deux appareils physiques doivent réellement échanger un segment via DataChannel — NON DÉMONTRÉ à ce stade. Ne pas élargir le trafic.

## Métriques (résumé machine : --json)
- ICE_SUCCESS_RATE : n/a (0/0)
- DATACHANNEL_SUCCESS_RATE : n/a (sessions ICE-ok avec DC ouvert : 0/0)
- PEER_SEGMENT_RATIO : n/a (0/0) · ORIGIN_SEGMENT_RATIO : n/a
- PEER_BYTE_RATIO : n/a (0 o) · ORIGIN_BYTE_RATIO : n/a
- CACHE_RATIO (memory+idb / tiers) : n/a
- FALLBACK_RATE : n/a · TIMEOUT_RATE : n/a · HASH_FAILURE_RATE : n/a
- STALL_RATE : n/a (0 stalls en ~0 h observées, max 0 ms) · erreurs lecture : 0
- RESILIENCE_A_B_C : NOT_OBSERVED (chaîne ×0 pairs relais, disparitions ×0, reprises origin ×0 / peer ×0)

## Tableau de décision
┌──────────────────────────────┬────────────┐
│ Critère                      │ Résultat   │
├──────────────────────────────┼────────────┤
│ ICE réel                     │ NON TESTÉ  │
│ DataChannel réel             │ NON TESTÉ  │
│ Segment P2P réel             │ NON        │
│ Offload                      │ NON MESURÉ │
│ Stall                        │ aucun      │
│ Fallback                     │ aucun      │
│ Résilience                   │ NOT_OBSERVED │
│ CGNAT                        │ MATRICE INCOMPLÈTE │
│ Android/WebView              │ NON TESTÉ  │
│ TURN                         │ INSUFFICIENT_DATA │
└──────────────────────────────┴────────────┘

DECISION CANARY: CONTINUE
DECISION TURN: INSUFFICIENT_DATA
Poursuivre au même palier (preuve ou volume manquant, sans signal STOP). Ne pas élargir.

## WebRTC (appareils réels uniquement)
- Tentatives ICE : 0 · réussies : 0 · échouées : 0
- Durée moyenne de connexion (succès) : n/a ms
- Paires host/srflx/relay : aucune paire observée
- DataChannel : open ×0 · close ×0 · error ×0 · HELLO acceptés 0/0 · backpressure ×0

## P2P (appareils réels uniquement)
- Transferts demandés (req) : 0 · réussis : 0 · servis (srv ok) : 0
- Tiers loader : peer ×0 · origin ×0 · memory ×0 · idb ×0
- Transferts corrélés A↔B : 0

## Qualité
- Timeouts : 0 · hash failures : 0 · fallbacks : 0 (aucun) · repli cassé (sans reprise) : ×0
- Stalls : 0 (total 0 ms, max 0 ms) · erreurs lecture : 0 · kill-switch : 0 événement(s)
- Sessions P2P (peerHits > 0) vs origin-only : 0 vs 0 (comparer stalls/erreurs entre les deux groupes avant toute conclusion)

## Résilience
- Aucun repli ni disparition observé (scénario C « disparition du peer » NON TESTÉ → RESILIENCE_A_B_C = NOT_OBSERVED).
- Exigence : peerResult en échec → tier origin sous ≤ timeout (1,5 s défaut), aucun blocage loader, stall > 5 s = STOP.

## TURN DECISION : INSUFFICIENT_DATA
- Tentatives ICE : 0 · succès : 0 · échecs : 0 (seuil : ≥ 10 tentatives, succès ≥ 60 %)
- Par classe d'appareil : n/a
- Par réseau : n/a
- Paires via relay observées : 0 (aucun TURN configuré : 0 attendu) · échecs : 0
- Volume insuffisant : NE PAS installer TURN. Ne jamais décider TURN sur 1-2 échecs.

## Statut de preuve (ne jamais mélanger)
- PROUVÉ EN PRODUCTION : signaling, auth, kill-switch, polling, WebSocket (batterie §6 edge + runbook étape 6 — hors captures, voir docs/operations/meshstream-step6-validation.md).
- PROUVÉ PAR MOCK : PeerLink, DataChannel, scoring, loader (tests unitaires : packages/mesh + workers — sans observations réelles ci-dessus).
- PROUVÉ SUR APPAREILS RÉELS : RIEN pour l'instant (aucune preuve tid complète) — seul ce qui est ci-dessus compte.
- NON TESTÉ : résilience disparition du peer · stalls en conditions réelles · matrice CGNAT multi-réseaux · Android/WebView/Android TV · décision TURN (données insuffisantes).

## STOP CONDITIONS (rappel opérateur)
kill-switch + canary OFF immédiats si : stall > 5 s · erreurs lecture en hausse · fallback origin cassé · boucle WebRTC · CPU/réseau/mémoire anormaux · crash · P2P non désactivable · comportement différent chez les utilisateurs non autorisés · fuite token/IP/URL dans la télémétrie. Conserver les logs, générer ce rapport, ne pas élargir.
