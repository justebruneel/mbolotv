# MeshStream — spécification technique v1

**Statut :** spécification normative ; **implémentée jusqu'à l'étape 5**
(worker mesh, client `@mbolo/mesh` avec cache persistant + scoring EWMA +
sélection adaptative, émission de jetons API). Le code est écrit et **testé
sous mocks** (WebRTC, IndexedDB et WebSocket simulés) mais **le P2P n'a jamais
été observé fonctionner entre deux navigateurs réels**, et le worker n'est pas
déployé. MeshStream reste inactif tant que `MESH_ENABLED` (API) n'est pas posé
et que `/play` ne délivre pas `p2p:true` ; sans ces flags la réponse `/play` et
le bundle du lecteur sont **inchangés** (le chunk mesh n'est même pas chargé).

Vue d'ensemble et justifications : `docs/adr/0004-meshstream-p2p.md`.
Schémas exécutables : `packages/contracts/src/mesh.ts` (source de vérité ; ce
document les commente, en cas de divergence c'est le code Zod qui gagne).

---

## 1. Diagramme d'architecture

```
                        ┌──────────────────────────────────────────────┐
                        │                 CÔTÉ FOURNISSEUR             │
  Chaîne IPTV ─────────►│  panels Xtream / Stalker / M3U               │
  (IP datacenter        │        ▲                                     │
   bloquées)            │        │ (sortie seulement via le relais)    │
                        └────────┼─────────────────────────────────────┘
                                 │
                   ┌─────────────┴──────────────┐
                   │   RELAI RÉSIDENCIAL        │  inchangé par MeshStream
                   │   cloudflared + eco-trans. │  (~10 Mbps uplink)
                   └─────────────┬──────────────┘
                                 │ upstream (mutualisé : 1 fetch/segment max)
        ┌────────────────────────▼───────────────────────────┐
        │        WORKER mbolo-tv-video-proxy  (inchangé)     │
        │  HMAC x-sig · cache edge · rewrite playlists ·     │
        │  DO SegmentCoordinator (single-flight)             │
        └───────┬────────────────────────────▲───────────────┘
   octets HLS   │ (chemin ORIGIN, toujours   │ octets manquants
   (manifest +  │  disponible)               │ uniquement
    segments)   ▼                            │
 ┌────────────────────────┐   SEGMENT_*      │  ┌────────────────────────┐
 │   CLIENT A (peer)      │◄══DataChannel═══►│  │   WORKER mbolo-tv-mesh │
 │  hls.js + MeshLoader   │                  └─►│  (NOUVEAU — étape 3)   │
 │  cache IndexedDB       │   SIGNAL_*/ICE_*    │  WebSocket + poll HTTP  │
 └───────────▲────────────┘◄══════════════════►│  DO SwarmCoordinator    │
             │ GET /play (p2p:true + token)    │  (1 instance par swarm) │
 ┌───────────┴────────────┐                    │  membership·candidats·  │
 │  WORKER mbolo-tv-api   │                    │  config·jetons·métriques│
 │  (existant, +1 champ)  │                    └───────────▲─────────────┘
 └────────────────────────┘                                │ ws / poll
                 ┌────────────────────────┐       ┌────────┴────────┐
                 │   CLIENT B (peer)      │◄═════►│  CLIENT C (peer)│
                 └────────────────────────┘  P2P  └─────────────────┘
```

Le coordinateur **ne touche jamais les octets vidéo**. La séparation est
architecturale : voies distinctes (WS/poll ≠ DataChannel ≠ HTTP proxy).

---

## 2. Modèle de swarm

### 2.1 Identité

Données réellement disponibles dans le projet (vérifié, schéma Prisma +
`play.js`) : `Source.id`, `Channel.id`, `StreamVariant.id`, le drapeau eco
(décision `ecoDecision()` → `maxh=480` ou absent), et — côté client seulement —
la rendition HLS choisie par l'ABR (`level.height`, `bitrate`, `codecs`) et le
`mediaSequence`/`discontinuityCounter` du manifest.

```
swarmId = hex128( HMAC-SHA256(MESH_URL_SECRET,
            "mswarm|1|" + sourceId + "|" + channelId + "|" + variantId + "|"
            + ecoFlag + "|" + renditionSig + "|" + streamEpoch) )[:32]
```

- `1` = version du format de calcul (montée si la composition change ; un
  client qui ne sait pas la produire ne rejoint pas, fallback origin).
- `ecoFlag` = `"eco"` si la réponse `/play` portait `maxh` (480), `"hd"` sinon.
  **Indispensable** : le proxy filtre le master par hauteur (`filterMasterByHeight`)
  — un pair éco et un pair HD n'ont pas les mêmes URL de variantes ni les mêmes
  octets : ils ne doivent jamais être dans le même swarm.
- `renditionSig` = `hex8(sha256("RESOLUTION,BANDWIDTH,CODECS"))` de la variante
  effectivement chargée par hls.js (côté client, après LEVEL_SWITCHED). Deux
  clients du même swarm peuvent parcourir des renditions différentes (ABR
  adaptatif) : c'est `rid` dans les messages qui protège l'échange, pas le
  swarmId. Le swarmId est calculé **sans** `rid` (sinon chaque montée ABR
  changerait de swarm), mais `HELLO` porte `rid` et un pair refuse tout
  `SEGMENT_REQUEST` dont le segment n'est pas dans sa propre rendition.
- `streamEpoch` : **résolu à l'étape 3 = `variantId`** (il ne figure donc PAS
  comme composante séparée dans la chaîne canonique). Justification vérifiée
  dans le code : `importer.js` fait `UPDATE "StreamVariant" SET
  "encryptedLocator" = …, "isActive" = true` sur les id existants lors des
  ré-imports — l'id survit ; un basculement de source sélectionne un AUTRE
  `variantId` (nouveau swarm). La rotation du locator (URL fournisseur qui
  change, same stream) ne doit PAS changer de swarm : les segments restent
  dans la même média sequence. `variantId` est donc exactement l'epoch
  déterministe recherché, sans colonne ni fragmentation.
- Canonicalisation : concaténation `|`-séparée, composantes brutes (cuid sans
  pipe par construction), pas d'URL-encoding (le HMAC opère sur des IDs
  opaques — `sourceId`/`channelId`/`variantId` **ne sortent jamais** du
  serveur ; l'hex128 tronqué empêche d'inférer les IDs et borne la taille).
- Collision : 128 bits → négligeable ; la troncature est délibérée (taille des
  messages WS) et le HMAC reste keyed : sans secret, pas de forging possible.

### 2.2 Changements

| Événement | Effet mesh |
|---|---|
| ABR change de rendition | même swarmId, `rid` mis à jour au prochain `HEARTBEAT` ; cache et pairs dont `rid` diffère écartés (pas de kick WS : simple retrait local du scoring) |
| Client switch `?eco=1` ↔ HD | nouveau `swarmId` : `LEAVE_SWARM(reason:"switching")` + `JOIN_SWARM` |
| Source de la chaîne change (re-sync/health check qui bascule la variante) | `variantId` change → swarmId change. La session `/play` en cours garde son URL jusqu'au refresh (`onRefreshSource` existant) ; au refresh, le pair suit la nouvelle variante. Les pairs de l'ancienne variante s'éteignent par TTL heartbeat |
| Playlist live tourne (mediaSequence avance) | **pas** de changement de swarm : le swarm est par flux, pas par fenêtre temporelle |
| `#EXT-X-DISCONTINUITY` traversé | pas de changement de swarm : l'identité de segment porte `cc` (cf. §6) — un pair ne sert que les segments de la fenêtre `cc` qu'il annonce |
| Owner désactive `p2pEnabled` (source/global) | `CONFIG.p2pEnabled=false` poussé aux membres → `LEAVE_SWARM` immédiats ; nouveaux clients : pas de token du tout (API) |
| Changement de swarm brutal (ex. token expiré, re-`/play`) | `LEAVE_SWARM(sid ancien)` puis `JOIN_SWARM(sid nouveau)` — le coordinateur n'exige pas le LEAVE (TTL de 90 s suffit), le LEAVE est un confort |

### 2.3 Scalabilité des swarms

- **N=2** : un lien, l'un seed l'autre, origin sert le direct. Aucun overhead.
- **N=100** : par JOIN, 8-12 candidats échantillonnés parmi les peers
  *window-compatibles* (fenêtre recouvrant les segments que le demandeur
  voudra, i.e. les plus récents) ; fan-out 4-6 par pair → ~500 liens max
  (bornés par `N×maxPeers/2`). La fenêtre glissante (24 segments max) empêche
  tout pair de « connaître » tout le monde — la découverte reste un échantillon.
- **N=1000** : un DO par swarm tient 1000 `PeerRecord` (SQLite) sans peine.
  Le coût serveur est dominé par `JOIN` et `HEARTBEAT` (batchés sur un même
  intervalle 30 s). Le message `PEER_JOINED` (broadcast aux seeders
  intéressés) est émis **uniquement aux peers qui suivent ce pair** (abonnés
  ≤ fan-out), jamais en broadcast plein. Si un swarm dépasse
  `MESH_SWARM_SOFT_LIMIT` (1500), les nouveaux joins reçoivent
  `JOIN_ACCEPTED{peers:[], cfg.p2pEnabled:false}` : ils restent clients
  origin sans erreur ni tempête de rejoin.

## 3. Modèle de peer

### 3.1 peerId

- **Génération** : 16 octets `crypto.getRandomValues()` côté client, à chaque
  **session de lecture** (mount du Player), encodés base64url sans padding
  (22 caractères, regex `[A-Za-z0-9_-]{22}`).
- **Aucun lien** avec `deviceId`/`deviceHash` : non déductible, non
  corrélable entre sessions (anti-tracking).
- **Durée de vie** = la session de lecture. Rechargement de page = nouveau
  peerId. Pas de persistance client (ni localStorage, ni IndexedDB).
- **Rotation intra-session** : à chaque `JOIN_SWARM` après un
  `LEAVE_SWARM(reason:"switching")` de plus de 5 min, le client régénère.
- **Validation serveur** : regex + correspondance exacte avec le `pid` du
  meshToken (le peerId est fixé À L'ÉMISSION du jeton par l'API ; un JOIN
  dont `id ≠ token.pid` → `INVALID_TOKEN`). Un pair ne peut donc jamais
  usurper un pairId qu'il n'a pas reçu.
- **IP** : jamais stockée (brute ou haschée) par le mesh. La limitation par
  appareil passe par `did = hex32(HMAC(MESH_URL_SECRET, deviceHash|YYYY-MM-DD))`
  recalculée serveur à l'émission du token — rotation quotidienne → pas de
  profilage longue durée ; le coordinateur ne voit que `did`.

### 3.2 Machine à états d'un peer (côté client)

```
                         ┌────────────┐
      mount Player ────► │    IDLE    │  pas de token / p2p=false → y reste
                         └─────┬──────┘
                     token reçu │ JOIN_SWARM
                         ┌─────▼────────┐   échec JOIN/WS + 3 retries
                         │   JOINING    │──────────────────────────► (retour IDLE,
                         └─────┬────────┘                             origin seul)
              JOIN_ACCEPTED    │
                         ┌─────▼────────┐
                         │ DISCOVERING  │  candidats reçus, sélection < maxPeers
                         └─────┬────────┘
              offer/answer ICE │
                         ┌─────▼────────┐
              ┌───────── │  CONNECTING  │
              │          └─────┬────────┘
              │   DataChannel  │ open
        ┌─────▼──────┐   ┌─────▼────────┐  3 échecs/RTT>seuil   ┌────────────┐
        │ (pair      │   │  CONNECTED   │──────────────────────►│  DEGRADED  │
        │  échoué :  │   │  (par pair)  │◄───── rétabli ────────┤ (pair-local│
        │  removal)  │   └─────┬────────┘                       └─────┬──────┘
        └────────────┘         │ DRAIN / cap→off                      │ 10 min
                          ┌────▼────────┐                    ┌────────▼───────┐
                          │  DRAINING   │                    │   UNRELIABLE   │ (noyade
                          └────┬────────┘                    │  locale : plus  │  de
                               │ connexions fermées          │  tenté, pairs   │  tentatives
                          ┌────▼────────────┐                │  purgeables)    │  10 min)
                          │ DISCONNECTED /  │                └─────────────────┘
                          │  pagehide/leave │
                          └─────────────────┘
```

États **globaux** du pair vu par le coordinateur (tableau §3.3) vs états **locaux
par connexion** (la machine ci-dessus, côté client) : le coordinateur ne
connaît que le pair entier, pas ses liens.

### 3.3 Table d'états (côté coordinateur) — `PeerRecord.state`

| État | Signifie | Transitions |
|---|---|---|
| `JOINING` | JOIN reçu, WS établi | → `CONNECTED` (premier HEARTBEAT) ; → supprimé (timeout) |
| `CONNECTED` | alive, heartbeat < 90 s | → `DRAINING` (DRAIN/cap off) ; → `EXPIRED` (silence) |
| `DRAINING` | ne doit plus être sélectionné comme seeder, lit encore | → supprimé (LEAVE ou TTL) |
| `EXPIRED` | interne : TTL dépassé, fiche à purger | → supprimé (alarm DO ≤ 30 s) |

`DEGRADED`/`UNRELIABLE` sont des états **clients locaux** (score) : le
coordinateur ne les stocke pas — il ne reçoit que `STATS_REPORT` agrégé.
Un pair `cap:"off"` est un pair normal, simplement jamais retenu comme
candidat seeder.

### 3.4 Informations publiées par un peer (minimum, rien de personnel)

`peerId, swarmId, proto, cap, net, rid, win{cc,first,last}, seq, ts` via
HEARTBEAT (30 s) — et `STATS_REPORT` (2 min, agrégés : upBytes, peerDlBytes,
peerOk, peerFail, rttMs). Pas de nom, pas d'UA, pas d'IP, pas de deviceId.

## 4. MeshToken

### 4.1 Format

```
token = b64url(JSON(payload)) + "." + b64url(HMAC-SHA256(MESH_URL_SECRET, b64url(JSON(payload))))
```

Même famille que la signature `x-sig` du proxy (`docs/security/proxy-url-signature.md`) :
HMAC court, sans dépendance JWT, vérifiable par le worker mesh **avec le seul
secret partagé — zéro appel PostgreSQL**. `crypto.subtle` disponible dans les
deux runtimes (Worker, et Node ≥ 19 pour les tests).

### 4.2 Payload (`meshTokenPayloadSchema`, strict)

```jsonc
{ "v": 1, "pid": "<peerId>", "sid": "<swarmId>", "did": "<limite-appareil>",
  "iat": 1757000000000, "exp": 1757003600000 }
```

Aucune donnée personnelle. Pas de `sourceId/cap/net` : la capacité peut
changer en session et ne doit pas exiger un re-jetonnage ; l'autorisation
d'accéder à la chaîne est déjà portée par `sid` (elle-même issue d'un
DeviceGrant vérifié par l'API).

### 4.3 Durée de vie et renouvellement

- `exp − iat` = TTL calé sur le token de lecture **amputé** :
  `min(play.expiresAt − now, 6 h)` avec plancher 15 min (un `/play` expire à
  24 h bucketés ; un pair de 6 h qui n'a pas renouvelé est éjectable proprement).
- Renouvellement : le client redemande `/play` avant expiration (React Query
  `staleTime` + `onRefreshSource` existant) OU plus tard un endpoint mesh de
  rafraîchissement (jeton frais présenté → jeton neuf) — hors périmètre v1.
- **Non réutilisable ailleurs** : `pid` et `sid` sont encodés dedans. Un voleur
  de token (MITM impossible en HTTPS) ne peut pas JOIN sous un autre peerId
  (comparaison `id == payload.pid` au handshake) et ne rejoint que le même
  swarm — où il ne reçoit que du signaling et ne sert que ce qu'il possède.

### 4.4 Signature et vérification (implémentation étape 3)

Signature par l'API (`play.js`) quand et seulement quand : `MESH_ENABLED=1`
+ `MESH_URL_SECRET` défini + `p2pEnabled` de la source (colonne future, défaut
false) + client `?` éligible (playResponse le saura seulement si le client
déclare le mesh dans un header `x-mesh: 1` — **à définir en étape 3**, hors
périmètre ici). Vérification au handshake mesh : HMAC constant-time, puis
`exp > now` **et** `iat ≤ now + 60_000` (tolérance d'horloge).

## 5. Protocole de signaling v1 (client ↔ coordinateur)

Définitions strictes : `mesh.ts` (Zod, discriminated unions, `.strict()`).
Enveloppe : `{v:1, t, sid, id, seq, ts, d}`. Messages épurés par rapport au
plan initial — justification des retraits en fin de section.

### 5.1 Tableau — montée (client → coord)

| `t` | Payload `d` | Utilité | Réponse |
|---|---|---|---|
| `JOIN_SWARM` | `{proto, cap, net, rid?}` | adhésion + config client | `JOIN_ACCEPTED` (peers + cfg) / `ERROR` |
| `LEAVE_SWARM` | `{reason?}` | départ propre (sinon TTL) | aucune |
| `HEARTBEAT` | `{win?, rid?, cap}` (30 s) | liveness + disponibilité segments | `PEER_JOINED`/`PEER_REMOVE` opportun (aux abonnés) |
| `STATS_REPORT` | agrégés 2 min (upBytes, peerOk/Fail, rtt) | télémétrie froide uniquement | aucune |
| `FALLBACK_PING` | `{sn, reason}` | mesure du gain réel (peers→origin) | aucune (optionnel, rate-limité ×10/min) |
| `SIGNAL_OFFER` | `{to, sdp}` | WebRTC offer → pair (routage pur) | `SIGNAL_OFFER` chez `to` |
| `SIGNAL_ANSWER` | `{to, sdp}` | WebRTC answer ← pair | `SIGNAL_ANSWER` chez `to` |
| `ICE_CANDIDATE` | `{to, c:[≤32]}` | batch ICE (perfect negotiation) | `ICE_CANDIDATE` chez `to` |

### 5.2 Tableau — descente (coord → client)

| `t` | Payload `d` | Quand |
|---|---|---|
| `JOIN_ACCEPTED` | `{peers:[≤12 {id,cap,win,rid,proto}], cfg}` | après JOIN validé |
| `PEER_CANDIDATES` | `{peers}` | re-sélection à la demande (si le pair a perdu ses liens) |
| `PEER_JOINED` | `{id,cap,win,rid,proto}` | notification ciblée (abonnés) d'un nouveau seeder potentiel |
| `PEER_REMOVE` | `{ids[≤32], why?}` | pair parti/expiré/kické (fermer ses DataChannels) |
| `CONFIG` | `meshConfigSchema` complet | changement à chaud (kill switch inclus) |
| `KICK` | `{why?}` | expulsion immédiate (fermer, ne plus revenir) |
| `DRAIN` | `{inMs?}` | arrêt progressif du seeding (ne plus accepter de demandes) |
| `ERROR` | `{code, retryAfterMs?}` | toute erreur (cf. §11, jamais de message libre) |
| `SIGNAL_OFFER/ANSWER` | `{from, sdp}` | livraison (le pair ne choisit pas sa cible : pas de `to` descendant) |
| `ICE_CANDIDATE` | `{from, c}` | livraison |

**Retraits assumés** (messages du plan non implémentés) : `PEER_DISCOVERY`
(c'est `JOIN_ACCEPTED`), `PEER_OFFER`/`PEER_ANSWER` (renommés `SIGNAL_*` :
« OFFER » prêtait à confusion avec l'offre de segments), `SEGMENT_AVAILABLE`
(couvert par `HEARTBEAT.win` — un annonce de segments fine-grain serait du
gossip inondant), `PEER_HEARTBEAT`/`PEER_STATS` (fusionnés), `PEER_UNHEALTHY`
(c'est `PEER_REMOVE{why:"unhealthy"}` + dégradation locale), `PEER_READY`/
`PEER_DRAINING` (redundants avec `HEARTBEAT.cap` + `JOIN`), `SEGMENT_UNAVAILABLE`
en descendant (message pair→pair, pas coordinateur).

### 5.3 Séparation signaling ≠ data

Les deux protocoles partagent la philosophie (version, seq, strict) mais sont
des **namespaces Zod distincts** : `meshClientMessageSchema` /
`meshCoordinatorMessageSchema` côté WS ; `meshP2pMessageSchema` (sans `sid`
ni `id` : l'identité est la DataChannel elle-même) côté WebRTC. Un message
de l'un dans l'autre canal = rejet (`test` figé).

## 6. Identité, récupération et intégrité des segments

### 6.1 Identité logique

`segmentKey = swarmId + ":" + cc + ":" + sn` — **jamais l'URL** (le proxy
réécrit et re-signe chaque URL enfant ; l'URL d'un pair ≠ l'URL origin ≠ une
URL d'hier).

Champs réellement exposés par hls.js 1.6 (vérité vérifiée dans les typings
`hls.js/dist/hls.js.d.ts`, classe `Fragment`) : `sn:number|'initSegment'`,
`cc:number`, `duration`, `programDateTime`, `elementaryStreams`
{audio,video:textlang}, **`url`** (`BaseSegment.url`, l'URL absolue chargée),
`relurl`. Donc : `(cc, sn)` stables ; **aucun hash n'est exposé par hls.js**.

Doublons : dédup par `segmentKey` dans le cache (clé unique IndexedDB + Map
mémoire). Discontinuités : `cc` incrémenté par hls.js à chaque
`#EXT-X-DISCONTINUITY` → un `cc` différent = segments incompatibles
(décodeurs/PTS distincts) : un pair ne sert jamais au-delà de son `cc` annoncé
et le demandeur exige `hellos.cc == frag.cc`. Changement de mediaSequence
(rotation live) : les `sn` sortent de la fenêtre glissante, ils cessent d'être
annoncés (le pair peut les purger du cache). Segment manquant côté peer :
`ERROR{SEGMENT_NOT_AVAILABLE}` → demande à un autre pair ou origin.
Segments d'init (`sn:'initSegment'`) : **non partageables en v1** (la
rendition `rid` varie ; l'init est petit et toujours disponible via le proxy
sans surcoût amont — il sort de la window annoncée).

### 6.2 Intégrité — trois couches, limites assumées

Aucun des candidats « hash fourni par l'origin » n'existe : ni `EXT-X-KEY`
sans AES, ni attribut hls.js. Options analysées :

| Option | Verdict |
|---|---|
| A. Hash calculé origin (le proxy ajouterait un header `x-seg-sha`) | **écarté en v1** : modifierait le datapath du video-proxy (interdit à l'étape 2, et un header par segment = coupling de release). Candidat sérieux pour l'étape 5+ si besoin |
| B. Hash calculé par le premier client (= l'émetteur) | **adopté** : `SEGMENT_COMPLETE.sha256` calculé sur les octets réellement lus par l'émetteur depuis SA cache source (origin ou pair vérifié). Détecte troncature/corruption/transit ; ne prouve pas l'authenticité (voir limites) |
| C. Fingerprint de quelques octets | écarté : trop faible pour 500 Ko |
| D. Chaîne de confiance (hash signé par l'origin) | écarté en v1 : exige A + une signature par segment |

**Le receveur vérifie : `sha256(assemblé) == SEGMENT_COMPLETE.sha256`**
(WebCrypto, disponible partout où le P2P tourne). Sur échec : segment écarté,
pair → erreur `CHECKSUM_MISMATCH`, marquage local DEGRADED, re-tentative via
un autre pair ou origin.

**Limites honnêtement documentées** : (1) un pair malveillant peut envoyer
`hash(octets_malveillants)` cohérent — le hash prouve l'intégrité du transit,
pas la légitimité du contenu ; (2) la détection de contenu « faux mais
cohérent » repose sur le MSE decode (bufferAppendError hls.js → `recoverMediaError`
échouant → purge du segment + pair UNRELIABLE + re-fetch origin) : c'est une
détection par le décodeur, pas par une preuve cryptographique ; (3) le
cross-swarm est bloqué structurellement (`HELLO.sid`, `HELLO.rid`, fenêtre
bornée) ; (4) le contenu illégitime injecté reste borné à ~24 s de vidéo par
pair — et le pair lui-même sera identifié par les `STATS_REPORT`. **MeshStream
ne prétend pas distribuer des contenus de confiance ; il ne distribue que des
flux auxquels le receveur a déjà droit** (jeton), et le chemin origin
authentifié reste l'arbitre en cas de doute.

### 6.3 Trames DataChannel

Texte (JSON ≤ 8 Ko, enveloppe §5 peer→peer) pour le contrôle ; binaire pour la
donnée. Trame binaire = en-tête 7 octets :
`[1] version=1 | [2..5] seqBE (nonce index) | [6..7] chunkIdx BE (0..n-1)` —
la taille du segment est connue par `SEGMENT_HEADER.len`. `chunks ≤
ceil(len/chunkBytes)` ; le receveur assemble, vérifie la longueur puis le hash,
et répond `SEGMENT_COMPLETE`. Un chunk = 64 Ko max (MTU-friendly,
maxMessageSize même si plus grand).

## 7. Capacité du peer — opt-in réel

- `off` : ne seed pas, n'accepte **aucune** connexion entrante (ne publie même
  pas sa fenêtre : `HEARTBEAT.win` absent). Consomme uniquement.
- `low` : accepte ≤ 2 entrants, débit total ≤ 512 Ko/s (limite d'émission
  locale), pause auto si l'upload saturé est observé.
- `normal` : ≤ `maxPeers` (4 défaut, 6 dur), ≤ 2 Mo/s.

**Auto-suspension du seeding** (temporaire, le pair redevient `off` côté
`HEARTBEAT` et le coordinateur l'exclut des candidats) :
`navigator.connection.saveData` vrai, `type ∈ {bluetooth, cellular}` (sauf
préférence explicite owner future), `document.visibilityState != "visible"`
> 60 s (l'API batterie `getBattery()` est ignorée : non dispo WebView/
GeckoView, permission-info leak — pas de permission invasive), `deviceMemory < 4`,
onLine faux. Reprise au retour des conditions.

Le réglage par défaut recommandé (étape 5, choix UI owner/client) : **desktop
wi-fi = `normal` après opt-in explicite au premier lancement du partage ;
mobile = `off` ; Android TV = `off`** — un mobile ne devient jamais un serveur
permanent par défaut.

## 8. Fan-out et bornes du graphe

Config (cf. §10) : `maxPeers` défaut **4**, plafond dur **6** (délibéré :
4 liens DataChannel à 1 Mbps soutenus + MSE + WS tiennent sur un téléphone
milieu de gamme ; les TV boxes sont `off`). Le coordinateur échantillonne
8-12 candidats ; le client sélectionne lui-même (buffer-local) ; un pair
`connected` en surnombre est retiré par `PEER_REMOVE` local sans message WS.
Liens totaux ≤ N×4/2 = **2N** : N=1000 → ≈ 2000 liens dans tout le système,
O(N) constant. Jamais full-mesh, jamais de topologie auto-organisée (le
coordinateur centralise la sélection, le client exécute : pas de protocole
de gossip à faire converger).

## 9. Durable Object `SwarmCoordinator`

Un DO **par swarm** (`idFromName(swarmId)` → l'instance est atteinte par sa
clé dérivée ; le `swarmId` réel circule en en-tête de service interne).
Classe déclarée **SQLite** (`new_sqlite_classes`) — obligation du plan
gratuit, même convention que le video-proxy — mais **l'état chaud est en
mémoire, sans table** (décision d'implémentation étape 3, précédent
`SegmentCoordinator` assumé et testé) : le membership EST éphémère par
concept ; après éviction/reprise de l'isolate, les clients reconnectent et
re-JOINent (idempotent par pid), et le TTL (120 s) bornerait de toute façon
un état persisté. La purge est portée par l'**alarme DO toutes les 30 s**
(`storage.setAlarm`, réarmée tant que le swarm a des pairs, supprimée quand
il se vide). Aucune donnée critique n'est perdue : le signaling est
reprise-à-zéro par conception.

PeerRecord (mémoire, `pid ->`), strictement minimal — **aucun** IP, nom,
email, token, URL IPTV, locator, deviceId :

```js
{ pid, state: 'JOINING'|'CONNECTED', cap, net, rid, proto,
  win: {cc,first,last}|null,           // null si cap=off (règle serveur)
  joinedAt, lastSeenAt,
  upBytes, peerDlBytes, peerOk, peerFail, rttMs,   // remplis par STATS_REPORT ; scoring RÉEL côté CLIENT (étape 5, peer-score.ts) — le serveur ne choisit jamais le pair émetteur (spec §12)
  pollMode, pollQueue /* [{n, raw}] ≤ 64 */, links /* Set<pid> */, rate /* ts[], 10 msg/s */ }
```

**Métriques froides** : `STATS_REPORT` comptés par pair ; l'agrégation
persistée (`MeshSwarmStat`, migration future, upsert 1/min) est reportée —
à l'étape 3, `GET /mesh/_stats?sid=` (admin) expose compteurs worker +
taille/counters du swarm, « combien, pas qui ».

## 10. Signaling : WebSocket + repli polling

### 10.1 WebSocket

- **Handshake** : `wss://<mesh>/ws?token=<meshToken>` → worker mesh →
  `SEGMENT` ? non — `idFromName(sid)` du token → `stub.fetchWebSocket(req)`
  vers le DO. Vérifs : HMAC, exp, `pid` unique (un second JOIN avec le même
  `pid` = remplace l'ancienne connexion, `KICK` sur l'ancienne).
- **Auth** : UNIQUEMENT au handshake ; ensuite la connexion EST le peer
  (mapping WS↔peerId en mémoire). Les messages n'ont pas à être resignés.
- **Heartbeat applicatif** : `HEARTBEAT` client toutes les 30 s (config) ;
  côté serveur : pas de ping WS (hibernation) ; l'absence > 90 s = expiration.
  Les pings TCP/`Ping` de §6 ne sont pas requis.
- **Reconnexion** : backoff exponentiel **500 ms → ×2 → 30 s max**, jitter
  ±30 % ; re-`JOIN_SWARM` à chaque reprise (le JOIN est idempotent).
  Sur `pagehide` : `LEAVE_SWARM` + `close(1000)`.
- **Changement de réseau** (`online` event ou `connectionchange`) : close
  immédiate (`1011 reason:"network"`) puis reconnexion — une socket sur un
  réseau mort reste « ouverte » pendant des dizaines de secondes.
- **Connexion morte sans événement** : le premier `SEGMENT_REQUEST` peer échoué
  OU l'absence de `PONG` après 2×heartbeat déclenche la fermeture proactive.
- **Hibernation** : `webSocketMessage` ne réveille que pour les JOIN/leave/
  heartbeat (logique), pas pour relayer (routage `sendBeforeConnected` —
  `webSocketSend` direct).

### 10.2 Repli HTTP polling

Déclenché après **3 échecs WS** consécutifs (handshake refusé, proxy
d'entreprise, WebView sans WS). Mode court, non pas long polling (les Workers
comptent chaque attente en ressources) :

- `GET /poll?token=..&cursor=..` — le worker DO accumule les messages
  descendants pour ce pair (file par pair, FIFO, **max 64 messages ou 10 s de
  rétention**, puis drop des plus vieux + `ERROR{RATE_LIMITED}` implicite par
  perte — le pair relance un JOIN s'il diverge). `cursor` = seq monotonique ;
  le serveur ne renvoie que `seq > cursor` (dédup).
- Intervalle : `cfg.pollIntervalMs` (4 s défaut, plancher 2 s) — 15 req/min
  par pair en mode dégradé, accepté et chiffrable vs 2 req/min en WS.
- Montée en polling : `POST /send?token=..` (mêmes enveloppes).
- Le pair ré-essaie WS toutes les 5 min en parallèle (retour automatique).

### 10.3 Perfect negotiation (documenté, implémenté étape 4)

Patron canonical (client ↔ client, symétrique) : `makingOffer` flag,
`polite` = comparaison déterministe `peerId` (lexicographique) ; les
`ICE_CANDIDATE` sont batchés par rafale 50 ms. Rôles : **le pair qui initie
le lien envoie `SIGNAL_OFFER`**, l'autre répond `SIGNAL_ANSWER` — le
coordinateur route sans ouvrir le SDP (il vérifie juste `to ∈ swarm` et la
taille). Détection `iceConnectionState == failed` → fermeture + exclusion
locale + re-sélection sur `PEER_CANDIDATES`.

## 11. Erreurs (coord→client, jamais de texte libre)

| Code | Signification | Client réagit |
|---|---|---|
| `INVALID_TOKEN` | HMAC faux / `pid≠id` / `sid≠token.sid` | re-`/play` (nouveau token) ou abandon mesh silencieux |
| `TOKEN_EXPIRED` | `exp` dépassé | re-`/play` puis re-JOIN |
| `INVALID_SWARM` | swarm inconnu/expiré (chaîne supprimée) | `LEAVE`, origin seul |
| `PROTOCOL_UNSUPPORTED` | `proto < minProtocolVersion` | origin seul (pas de retry : version figée tant que le client n'est pas mis à jour) |
| `PEER_NOT_FOUND` | routage `SIGNAL_*` vers un pair parti | ignorer (le pair cible a son propre timeout) |
| `RATE_LIMITED` | > 10 msg/s ou flood JOIN | backoff ×2, max 60 s |
| `SWARM_FULL` | > soft limit | origin, retry JOIN dans 5 min |
| `INVALID_MESSAGE` | Zod échoué (taille/champ) | drop + télémétrie, ne pas re-tenter |
| `PEER_DRAINING` | réponse à un JOIN vers pair drainant | ne pas tenter ce pair |
| `INTERNAL` | erreur DO inattendue | origin + re-JOIN unique |

Pair→pair (DataChannel) : `SEGMENT_NOT_AVAILABLE`, `BAD_REQUEST`,
`OVERLOADED`, `CHECKSUM_MISMATCH`, `PROTOCOL_UNSUPPORTED`, `INTERNAL`.

## 12. Kill switch (niveaux effectifs, récapitulatif)

| Niveau | Porteur | Effet |
|---|---|---|
| `GLOBAL_P2P_ENABLED` | var env `MESH_ENABLED` absente/fausse (API) → `p2p:false` | aucun token émis, le client ne voit rien |
| `SOURCE_P2P_ENABLED` | colonne future `Source.p2pEnabled` (défaut **false**) | même chaîne : pas de token → origin pur |
| Runtime global | `CONFIG.p2pEnabled=false` poussé par le coord | pairs existants quittent dans l'heure (heartbeat), nouveaux refusés |
| Runtime source | coord refuse JOIN pour les `sid` dont la source est éteinte (flag passé à l'émission du token, ou re-vérif à chaud étape 5) | idem |
| `CLIENT_P2P_CAPABLE` | détection runtime : `MediaSource` + `Hls.isSupported()` + `RTCPeerConnection` + DataChannel | pas de capacité → jamais de mesh, streaming actuel inchangé |
| `PEER_UPLOAD_ENABLED` | `cap:"off"` | consomme, ne seed pas, non-sélectionnable |

Toute combinaison « pas de P2P » = le comportement actuel, ligne à ligne.

## 13. Configuration centralisée (`meshConfigSchema`)

Un seul objet versionné, poussé à chaud par `CONFIG` ; **aucun nombre magique
hors de `mesh.ts`**. Valeurs par défaut normatives (détaillées + justifiées
au client) :

```
p2pEnabled: true (à l'activation globale), maxPeers: 4, peerTimeoutMs: 1500,
bufferCriticalSec: 12, liveEdgeSafetySegments: 2, heartbeatMs: 30000,
statsIntervalMs: 120000, pollIntervalMs: 4000, candidateSample: 8,
windowSize: 20 (≤ MESH_MAX_WINDOW_SEGMENTS 24), chunkBytes: 65536,
protocolVersion: 1, minProtocolVersion: 1
```

Le client ne lit JAMAIS de défaut codé en dur avant le premier `CONFIG` :
sans config, pas de P2P (join = attente de `JOIN_ACCEPTED{cfg}`).

**Timeouts de récupération (règle §10 du brief, chiffrés)** :
demande pair → origin bascule si > **1 500 ms** (segment de 4 s = 2,5 s de
marge récupérée dans un buffer ≥ 12 s) ; deux pairs interrogés en parallèle
(1 500 ms chacun) ; buffer < `bufferCriticalSec` → **origin immédiat, zéro
pari pair** ; live edge (sn dans les `liveEdgeSafetySegments` derniers) →
origin (un pair ne peut pas avoir ce qu'il n'a pas reçu) ; origin down → la
chaîne de retry Player existante (`advance()`, `onRefreshSource`) — MeshStream
n'invente aucune erreur.

## 14. Compatibilité par classe de client (état de l'art vérifié, non testé sur notre parc)

| Classe | MSE ? | hls.js loader ? | WebRTC DC ? | P2P ? | Seeding ? | Fallback |
|---|---|---|---|---|---|---|
| Desktop Chromium | ✅ | ✅ | ✅ | ✅ | ✅ normal | origin |
| Desktop Firefox | ✅ | ✅ | ✅ | ✅ | ✅ normal | origin |
| Safari macOS 12+ | ✅ | ✅ | ✅ | ✅ | ✅ normal (throughput DC à mesurer) | origin |
| iOS Safari < 17 | ❌ | ❌ (playback natif) | ✅ mais inutile | **❌** | ❌ interdit | origin (actuel) |
| iOS/PadOS ≥ 17 | ⚠️ limité | ⚠️ théorique | ✅ | ⚠️ à tester réel | ❌ interdit (arrière-plan tue WS+WebRTC) | origin |
| Android WebView moderne (Chrome ≥ 90) | ✅ | ✅ | ✅ | ✅ | ⚠️ low (data saver, batterie) | origin |
| Android TV WebView | ✅ souvent | ✅ | ⚠️ provider dépendant | ⚠️ détecté runtime | ❌ off par défaut (CPU/RAM) | origin |
| Android TV GeckoView (arm32) | ✅ (Gecko MSE) | ✅ | ✅ (DataChannel Gecko) | ⚠️ non testé, à valider en étape 4 | ❌ off | origin |

Non promis : toute capacité non vérifiée sur le parc réel (mesures en étape 4,
grâce à la télémétrie `FALLBACK_PING`/`STATS_REPORT` — pas d'activation
« parce que la doc dit que »).

## 15. Bases de données (étapes futures, PAS de migration à l'étape 2)

Prévues (documentées ici, non créées) : `Source.p2pEnabled Boolean @default(false)` ;
`MeshSwarmStat {swarmIdDay, peers, served, originFallback}` (analytique froide
upsert 1/min) ; `StreamVariant.meshEpoch DateTime` si la tranché §2.1 le
confirme. Interdits : toute table de membership temps réel (c'est le DO),
toute IP.

## 16. Ce qui est explicitement hors périmètre (étape 2)

Tout déploiement (worker `mbolo-tv-mesh`, `packages/mesh`, `MeshLoader`,
Player, `play.js`, wrangler, TURN, migrations Prisma). Cet ADR + ce document +
les contrats Zod testés sont les seuls livrables.

## 17. Optimisation bande passante (v1.1, production)

### Avant

```
Origin ──┬──► Client A
         ├──► Client B
         └──► Client C
```

Chaque client télécharge chaque segment depuis l'origine : N clients = N
téléchargements origin du même segment.

### Après

```
                ┌──► Client B
Origin ──► A ───┤
                └──► Client C
```

A = seeder (reçoit d'origin, annonce sa fenêtre), B/C = receivers (parient P2P
sous gardes, fallback origin sinon). Et, dans les limites v1 (fenêtre live,
TTL cache, pas de fetch-pour-servir) :

```
Origin → A → B → C
```

un segment validé chez B (hash vérifié à réception) est servable à C — sans
jamais faire de A un relais généraliste (plafond `maxUploads = 2`, 1 transfert
à la fois par lien, OVERLOADED = échec souple).

### Ce que cela signifie physiquement

La bande passante résidentielle n'est pas « déplacée » depuis l'adresse IP du
fournisseur. Le fournisseur envoie les octets au premier client ; WebRTC
permet ensuite à ce client de transmettre directement les MÊMES octets à
d'autres clients, ce qui évite des téléchargements supplémentaires depuis
l'origine. Le Mesh Worker ne voit jamais ces octets (signaling seul).

### Règles conservées (fluidité > économie, toujours)

- Buffer critique / live edge dangereux → origin, sans pari pair.
- Buffer normal → pair si score ≥ confiance ; confortable (≥ 2× critique) →
  prefetch peer-only du segment suivant (jamais origin, jamais bloquant).
- Sélection : score EWMA (succès, débit, RTT, fraîcheur, upload, stabilité) +
  lien libre d'abord (pas de meute sur le même seeder) + rotation déterministe.
- Débit réel mesuré (octets/durée) en EWMA ; un seul transfert ne décide jamais.
- Coalescence `cc:sn` : N demandes simultanées = 1 transfert, 1 métrique.
- Sécurité inchangée : clé `swarmId:cc:sn` uniquement, hash+longueur vérifiés
  avant cache, cross-swarm/rendition refusés, aucun token/IP/URL au pair.
- Métriques : `originRequestsAvoided` (+1 par segment logique sans origin ;
  mémoire→IDB ne compte jamais double), ratios existants inchangés.
