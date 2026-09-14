# MeshStream — Phase canary : protocole de test humain (étape 6)

**Statut : BÊTA TECHNIQUE PRIVÉE. Pas de déploiement public.**
Le streaming classique reste prioritaire. Le P2P est opportuniste : en cas de
doute, il s'efface et l'origin sert. Ce document s'adresse aux 2-10 testeurs
explicitement inscrits dans `MESH_TESTER_ALLOWLIST` (jamais au public).
**Aucune donnée personnelle n'est demandée** : ni nom, ni email, ni adresse —
uniquement des exports techniques anonymisés (voir § Export).

Pré-requis opérateur (voir `meshstream-canary-killswitch.md`) :
front **preview canary** (`NEXT_PUBLIC_MESH_POC=1`, jamais la prod), API de test
(`MESH_ENABLED=1` + `MESH_ENFORCE_ALLOWLIST=1` + `MESH_SOURCE_ALLOWLIST`
sans `*` + allowlist testeurs sans `*`), worker mesh joignable, kill-switch
testé AVANT (scénario § kill-switch OK).

---

## 0. Démarrage express (9 étapes, 15 minutes)

1. Ouvrir le **lien Canary** transmis par le responsable (pas l'URL publique).
2. En console, taper `window.__meshTest.setRunId('<run-id>')` (run-id transmis
   par le responsable, ex. `run-2026-09-14-a-b`) → doit répondre `true`.
3. Lancer la **chaîne de test** indiquée, même qualité des deux côtés.
4. Laisser tourner **10 minutes minimum** sans changer de chaîne.
5. Vérifier que le P2P est actif : filtrer `[mesh-test]` en console (lignes
   `ice`, `dc`, `tier`), ou taper `window.__meshTest.dump()` et constater
   `peers ≥ 1` / `peerHits > 0` côté consommateur. **Si rien après 3 minutes,
   le signaler tel quel** (c'est un résultat, pas un échec à masquer).
6. Ne rien faire de spécial sauf si le scénario le demande (coupure réseau,
   arrière-plan, fermeture — voir § Scénarios).
7. Revenir sur la page si vous l'aviez quittée ; noter tout freeze (heure +
   durée). **Freeze > 5 s → STOP** (voir § STOP CONDITIONS), onglet conservé.
8. Exporter : `window.__meshTest.export()` (fichier téléchargé) ou
   `copy(JSON.stringify(window.__meshTest.dump()))` collé dans un fichier.
9. Transmettre le fichier au responsable. Terminé — aucune autre action.

## 1. Préparation détaillée (une fois par appareil)

1. Ouvrir le lien preview canary. Ouvrir la console développeur → filtrer
   `[mesh-test]`.
2. Avant lecture : aucun `[mesh-test]`, aucune `window.__meshTest` (tant que la
   chaîne de test n'est pas lancée et que `/play` n'a pas renvoyé `p2p:true` —
   un testeur NON autorisé ne voit jamais rien de tout cela : comportement
   strictement classique).
3. **Seeders désignés uniquement** : `localStorage.setItem('mbolo:mesh-cap',
   'normal')` puis recharger. Les autres ne touchent à rien (`off` = réception
   seule, jamais d'upload).
4. Noter : heure de début, appareil (« PC salon », « téléphone A »), réseau
   (Wi-Fi maison / data mobile / autre). Jamais de nom personnel.

## 2. Règles communes

- Même rendition des deux côtés (sélecteur qualité identique).
- Pas de changement volontaire de réseau (sauf TEST C/E qui le demandent).
- Noter chaque freeze/stall (heure + durée approximative).
- Exporter depuis CHAQUE appareil, même si « il ne s'est rien passé ».

**Confidentialité :** le dump ne contient ni IP, ni URL de flux, ni token, ni
identifiant personnel (`mesh-capture` REJETTE tout fichier suspect au lieu de
le « nettoyer »). Ne jamais ajouter d'infos personnelles dans les notes.

---

## 3. Scénarios

### TEST A — Deux appareils, même Wi-Fi (premier test, 2 testeurs)
- A et B sur le **même Wi-Fi**. A = seeder (`mbolo:mesh-cap=normal`, 60 s
  d'avance, ≥ 8 segments bufferisés), B = consommateur (défaut).
- Attendu honnête : ICE `host→host` probable. Preuve visée : `transfer`
  req+srv de même `tid`, octets > 0, `tier:'peer'` injecté côté B.
- Relever : `peerHits`/`originHits`/`peerHitRate`/`meshOffload` des deux dumps.

### TEST B — Trois appareils en chaîne A→B→C (3 testeurs)
- A seede (avance), B lit ET seede (clé `normal`, 60 s d'avance sur C), C
  consomme (défaut). Même Wi-Fi, même chaîne, démarrages décalés (A, puis B
  +60 s, puis C +60 s).
- Objectif : mutualisation — C servi (au moins partiellement) par B pendant
  que B est servi par A. Preuve visée : B figure à la fois en `req ok` (depuis
  A) et en `srv ok` (vers C) ; le rapport calcule `RESILIENCE_A_B_C`.
- Ne jamais valider ce scénario sur événements simulés : seuls les dumps des
  trois appareils réels comptent.

### TEST C — Disparition d'un pair (résilience)
- A seede, B consomme avec `peerHits > 0` constaté. Puis sur A, **un seul cas
  par test** : (1) fermer l'onglet · (2) couper le Wi-Fi 10 s · (3) tuer le
  navigateur. Variante chaîne : B disparaît pendant que C lit (A→B→C, puis
  C doit reprendre depuis A ou origin).
- Sur le survivant : la lecture doit continuer (`peerResult` en échec →
  `tier:'origin'` sous ≤ 1,5 s, aucun blocage du loader). Noter le trou.
- **Critère dur : stall > 5 s → STOP** (bug bloquant avant toute suite).

### TEST D — Kill-switch live (opérateur + testeurs)
- Pendant une session P2P active (`peerHits > 0`) : l'opérateur pose
  `MESH_KILL_SWITCH=1`. Les testeurs **ne rechargent rien** et observent :
  `{t:'kill',enabled:false}` en console, arrêt des `peerHits`, lecture origin
  continue sans coupure. Puis l'opérateur rouvre : re-JOIN automatique +
  reprise P2P **sans reload**.
- Relever : heures ON/OFF/reprise, stalls éventuels, `killEvents` des dumps.

### TEST E — Réseaux différents
- A en Wi-Fi, B en **data mobile** (ou autre connexion). Puis inverser.
- Attendu : paire `srflx` possible ; `ice:failed` répété se NOTE sans conclure
  (TURN interdit sous 10 tentatives, voir rapport `TURN_DECISION`).

### TEST F — Arrière-plan
- B en **arrière-plan** (autre onglet / écran verrouillé) 2 minutes puis
  retour. A au premier plan.
- Attendu : B `cap:off` (`capacity` + `visibility:background`), lecture
  maintenue, `republish` + re-JOIN au retour sans recharger.

### TEST G — Android / WebView (si disponible)
- Refaire A avec un téléphone Android (Chrome). Noter `deviceClass:mobile`.
- WebView (GeckoView / app embarquée) : valider **séparément**, ne jamais
  extrapoler depuis Chrome desktop.

### TEST H — Android TV (si disponible)
- Capacité OFF par défaut : **RÉCEPTION seulement**. Noter `deviceClass:tv`,
  fluidité, `peerHits` éventuels.

## 4. Fiche de relevé (une par test)

| Champ | Valeur |
|---|---|
| Run ID (setRunId, identique sur tous les appareils) | |
| Scénario (A/B/C/D/E/F/G/H) | |
| Heure début / fin | |
| Appareils (classe, réseau, seeder oui/non — ex. A/B/C) | |
| P2P actif constaté (oui/non, peerHits) | |
| Stalls (heure + durée) | |
| ICE (connected/failed, paire host/srflx/relay) | |
| Segments P2P (peerHits, offload) | |
| Fallbacks origin observés | |
| Coupure/reprise (TEST C/D : heures) | |
| Fichiers envoyés (raw-*.json) | |
| Remarques (sans données personnelles) | |

## 5. STOP CONDITIONS (arrêt immédiat, sans discuter)

`stall > 5 s` · hausse des erreurs de lecture · fallback origin cassé · boucle
WebRTC (re-JOIN incessants) · CPU/réseau/mémoire anormaux · crash · P2P non
désactivable · **comportement différent chez les utilisateurs non autorisés**
(ils doivent rester en streaming strictement classique) · **fuite token/IP/URL
dans la télémétrie**.
Conduite : 1) kill-switch (`MESH_KILL_SWITCH=1`) 2) canary OFF (retirer les
testeurs / couper `MESH_ENABLED` sur l'API de test) 3) conserver onglets + logs
4) exporter les dumps 5) rapport automatique 6) **aucune extension du groupe**.

## 6. Montée en charge (décidée, jamais automatique)

2 testeurs (TEST A) → rapport `DECISION_CANARY` → 3 (TEST B) → rapport → 5 →
rapport → éventuellement 10. **Gate par palier** : `REAL_P2P_VIDEO=VALIDATED`
(requis dès le palier 2 pour continuer le P2P), aucun signal STOP, qualité P2P
comparée à origin-only. `EXPAND` du rapport = proposition (seuils provisoires),
décision finale = opérateur. En cas de dégradation : retirer un appareil,
documenter, STOP si STOP CONDITIONS.

## 7. Fin de test / rollback (sans redéploiement)

1. `MESH_KILL_SWITCH=1` (mesh neutre, lecture intacte) 2) retirer
   `MESH_ENABLED` sur l'API de test (plus aucun jeton) 3) fermer le preview
   canary 4) vérifier la prod inchangée : `/play` sans `p2p`, aucun
   `[mesh-test]` possible, chunk mesh non chargé.
