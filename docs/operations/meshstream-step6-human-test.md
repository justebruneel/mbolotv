# MeshStream — Phase canary : protocole de test humain (étape 6)

**Statut : BÊTA TECHNIQUE PRIVÉE. Pas de déploiement public.**
Le streaming classique reste prioritaire. Le P2P est opportuniste : en cas de
doute, il s'efface et l'origin sert. Ce document s'adresse aux 2-10 testeurs
explicitement inscrits dans `MESH_TESTER_ALLOWLIST` (jamais au public).

Pré-requis opérateur (voir `meshstream-canary-killswitch.md`) :
front **preview canary** (`NEXT_PUBLIC_MESH_POC=1`, jamais la prod), API de test
(`MESH_ENABLED=1` + `MESH_SOURCE_ALLOWLIST=<source-éco-test>` + allowlist
testeurs), worker mesh joignable, kill-switch testé AVANT (scénario § kill-switch OK).

---

## 1. Préparation (2 minutes, une fois par appareil)

1. Ouvrir le lien preview canary transmis par le responsable (pas l'URL publique).
2. Ouvrir la console développeur → onglet Console → filtrer `[mesh-test]`.
3. Vérifier l'absence de mesh avant lecture : aucun `[mesh-test]`, aucune
   `window.__meshTest` (tant que la chaîne de test n'est pas lancée).
4. **Appareil seeder uniquement** (celui qui PARTAGE — désigné par le
   responsable) : dans la console, taper :
   `localStorage.setItem('mbolo:mesh-cap','normal')` puis recharger la page.
   Les autres appareils ne touchent à rien (ils consomment par défaut, `off`).
5. Noter : heure de début, appareil (ex. « PC salon », « téléphone A » — jamais
   de nom personnel), réseau (Wi-Fi maison / data mobile / autre).

## 2. Lecture de test (commun à tous les scénarios)

1. Lancer la **chaîne de test** indiquée (rendition éco, même qualité des deux
   côtés — vérifier le sélecteur qualité identique).
2. Rester sur la chaîne **10 minutes minimum** sans changer de chaîne.
3. Ne pas changer volontairement de réseau pendant le test (sauf scénario C/D
   qui le demande).
4. Noter tout **freeze / stall / saccade** : heure, durée approximative
   (ex. « 10:04 — freeze ~2 s »). Si freeze **> 5 s → STOP** : appliquer
   STOP CONDITIONS (§ 5), garder l'onglet ouvert pour l'export.
5. À la fin : dans la console de CHAQUE appareil, exécuter :
   `copy(JSON.stringify(window.__meshTest.dump()))`
   puis coller dans un fichier `raw-<appareil>.json` et l'envoyer au responsable.
   Alternative : `window.__meshTest.export()` télécharge le fichier directement.
6. Le responsable assemble : `node scripts/mesh-capture.mjs --in raw-*.json
   --out mesh-test-runs/<run-id>.json --run <run-id> --scenario <X>`
   puis `node scripts/mesh-report.mjs ./mesh-test-runs/<run-id>.json`.

**Confidentialité :** le dump ne contient ni IP, ni URL de flux, ni token, ni
identifiant personnel (garde-fou automatique : `mesh-capture` REJETTE tout
fichier suspect au lieu de le « nettoyer »). Ne jamais ajouter d'infos
personnelles dans les notes.

---

## 3. Scénarios

### TEST A — même réseau Wi-Fi (premier test, 2 testeurs)
- A et B sur le **même Wi-Fi**. A = seeder (`mbolo:mesh-cap=normal`, 60 s de
  lecture d'avance, ≥ 8 segments bufferisés), B = consommateur (défaut).
- Attendu honnête : ICE `host→host` probable, `candidatePair` DIRECT.
- Relever : `peerHits`/`originHits`/`peerHitRate`/`meshOffload` des deux dumps,
  lignes `{t:'peerResult',ok:true}` + `{t:'tier',tier:'peer'}` sur le même
  `(cc,sn)` côté B, `transfer` req+srv partageant le même `tid` (le rapport le
  vérifie automatiquement).

### TEST B — réseaux différents
- A en Wi-Fi, B en **data mobile** (ou autre connexion). Puis inverser.
- Attendu : paire avec `srflx` possible (STUN_SUCCESS) ; un `ice:failed` répété
  se NOTE sans conclure (décision TURN interdite sous 10 tentatives).
- Relever : même tableau que A + type de réseau de chaque appareil.

### TEST C — disparition du peer (résilience)
- A seede, B consomme avec `peerHits > 0` constaté. Puis sur A, **un seul cas
  par test** : (1) fermer l'onglet · (2) couper le Wi-Fi 10 s · (3) tuer le
  navigateur.
- Sur B : la lecture doit continuer (`peerResult` en échec → `tier:'origin'`
  sous ≤ 1,5 s, aucun blocage du loader). Noter le trou éventuel.
- **Critère dur : stall > 5 s → STOP** (bug bloquant avant toute suite).

### TEST D — arrière-plan
- B passe en **arrière-plan** (autre onglet / écran verrouillé) 2 minutes puis
  revient. A reste au premier plan.
- Attendu : B passe `cap:off` (événement `capacity` + `visibility:background`),
  ne seed plus, continue de LIRE ; au retour, `republish` + re-JOIN sans
  recharger la page.

### TEST E — Android / WebView (si disponible)
- Refaire A avec un téléphone Android (Chrome). Noter `deviceClass:mobile`,
  stalls éventuels, `iceResult`/`candidatePair`.
- WebView (GeckoView / app embarquée) : valider **séparément**, ne jamais
  extrapoler depuis Chrome desktop.

### TEST F — Android TV (si disponible)
- Capacité par défaut OFF : tester la **RÉCEPTION seulement** (pas de seeding
  forcé). Noter `deviceClass:tv`, fluidité, `peerHits` éventuels.

## 4. Fiche de relevé (une par test)

| Champ | Valeur |
|---|---|
| Run ID | |
| Scénario (A/B/C/D/E/F) | |
| Heure début / fin | |
| Appareil A (classe, réseau, seeder oui/non) | |
| Appareil B (classe, réseau, seeder oui/non) | |
| Stalls (heure + durée) | |
| ICE (connected/failed, paire host/srflx/relay) | |
| Segments P2P (peerHits B, offload) | |
| Fallbacks origin observés | |
| Fichiers envoyés (raw-*.json) | |
| Remarques | |

## 5. STOP CONDITIONS (arrêt immédiat, sans discuter)

`stall > 5 s` · hausse des erreurs de lecture · fallback origin cassé · boucle
WebRTC (re-JOIN incessants) · CPU/réseau/mémoire anormaux · crash · P2P non
désactivable · **fuite token/IP/URL dans la télémétrie**.
Conduite : 1) kill-switch (`MESH_KILL_SWITCH=1`) 2) canary OFF (retirer les
testeurs / couper `MESH_ENABLED` sur l'API de test) 3) conserver onglets + logs
4) exporter les dumps 5) rapport automatique 6) **aucune extension du groupe**.

## 6. Montée en charge (décidée, jamais automatique)

2 testeurs (A→B) → analyser le rapport → 3 → rapport → 5 → rapport →
éventuellement 10. Chaque palier exige un rapport `REAL_P2P_VIDEO` + qualité
comparée P2P vs origin-only. En cas de dégradation : retirer un appareil,
documenter, STOP si STOP CONDITIONS.

## 7. Fin de test / rollback (sans redéploiement)

1. `MESH_KILL_SWITCH=1` (mesh neutre, lecture intacte) 2) retirer
   `MESH_ENABLED` sur l'API de test (plus aucun jeton) 3) fermer le preview
   canary 4) vérifier la prod inchangée : `/play` sans `p2p`, aucun
   `[mesh-test]` possible, chunk mesh non chargé.
