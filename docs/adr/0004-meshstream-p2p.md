# ADR-0004 — MeshStream : distribution P2P par segments

**Date :** 2026-09-12
**Statut :** Acceptée — implémentée jusqu'à l'**étape 5** (client + worker + API).
Le P2P reste **désactivé par défaut** (flags env) et **non testé sur de vrais
appareils/navigateurs** : tout ci-dessous est validé par des tests unitaires
sous mocks (WebRTC, IndexedDB et WebSocket simulés), jamais par une session
réelle entre deux machines.
**Contrairement à :** rien ; complète ADR-0002 (backend Worker unique) et la
signature HMAC documentée dans `docs/security/proxy-url-signature.md`.

## Problème

Le relais résidentiel (uplink ~10 Mbps) est le point de sortie des fournisseurs
IPTV qui bloquent les IP datacenter. L'audit (septembre 2026) a établi que la
distribution origin → clients repose déjà sur trois protections fortes :

1. **Single-flight Durable Object** (`SegmentCoordinator`) : au cache-miss,
   un seul fetch upstream par segment, les autres viewers attendent ;
2. **Cache edge Cloudflare** (`caches.default`, segments TTL 30-90 s) :
   un segment n'est tiré qu'une fois par fenêtre et par POP ;
3. **Eco-transcodeur** (~1 Mbps/chaîne, seuils automatiques 3/8 chaînes).

**Conclusion d'audit explicite : le scénario « plusieurs clients regardent la
même chaîne → le relais sature » est déjà traité** — l'affluence par chaîne
coûte ~1 fetch amont, pas N. MeshStream ne prétend donc PAS éliminer la
consommation du relais résidentiel ; le relais restera le chemin de l'upstream
chaque fois qu'un segment nouveau doit être cherché chez le fournisseur.

## Pourquoi MeshStream malgré tout

MeshStream est une technologie de :

- **scalabilité** — décharger le egress Cloudflare (proxy → clients) et tenir
  sous les limites du plan (100k req/jour) quand l'audience croît ;
- **réduction de certaines transmissions origin → client** — les segments déjà
  vus par des voisins n'ont plus à traverser le proxy jusqu'à ces clients-là ;
- **résilience** — si le proxy ou un POP dégrade, les pairs voisins peuvent
  encore couvrir le passé immédiat du direct (jamais le live edge) ;
- **distribution coopérative** — plusieurs appareils d'un même foyer (TV +
  téléphone) mutualisent localement ;
- **réduction potentielle de latence** — un pair sur le même réseau que l'ISP
  du client bat un aller-retour Cloudflare→relais→fournisseur ;
- **capacité de préparation** — le socle (swarms, jetons, scoring) existe
  avant d'en avoir désespérément besoin.

## Ce que MeshStream ne résout PAS

- Le coût du **premier** fetch d'un segment vers le fournisseur (chemin
  unique, toujours origin) — le P2P ne multipasse pas l'upstream, il multipasse
  la descente ;
- La **capacité du relais en chaînes simultanées distinctes** (c'est
  l'eco-transcodeur et les seuils qui la bornent, inchangés) ;
- La **connectivité sous CGNAT strict** sans TURN (30-50 % des clients mobiles
  estimés ne feront jamais de P2P direct — fallback origin transparent) ;
- Le **iOS < 17** et tout client sans MSE : pas d'injection de loader, donc
  pas de P2P du tout pour eux (ils restent des clients normaux) ;
- Les **contenus sous DRM**, et tout contenu dont la licence interdit la
  redistribution (kill switch par source, cf. infra).

## Décision

### Architecture cible

```
Fournisseur IPTV ⇄ relais/cloudflared ⇄ VIDEO-PROXY (edge cache, inchangé)
                                              │ octets (origin fallback)
                                              ▼
CLIENT hls.js ── MeshLoader ──► PEERS (WebRTC DataChannel, segments)
   │        ↖______________________________↗
   │ ws/poll (signaling uniquement, jamais d'octets)
   ▼
MESH WORKER (mbolo-tv-mesh, Cloudflare Worker)
   └── Durable Object SwarmCoordinator (un par swarm, SQLite storage)
         membership · heartbeat · candidats · signaling relay · CONFIG
   (signature de jetons HMAC — aucun accès Postgres dans le chemin temps réel)
```

Trois nouveaux composants seulement : un Worker mesh, un DO par swarm, un
module client (`packages/mesh`) branché plus tard sur un `loader` hls.js
custom. **Rien d'existant n'est modifié dans le chemin de streaming** : le
video-proxy, le Player, mpegts.js, le chemin Safari, le relais, l'eco et les
crons restent intacts. `GET /api/channels/:id/play` gagnera plus tard trois
champs **optionnels** (`p2p`, `meshToken`, `meshUrl`) ; en l'absence de ces
champs le client se conduit exactement comme aujourd'hui.

### Responsabilités

| Composant | Fait | Ne fait PAS |
|---|---|---|
| Worker mesh + DO | membership, découverte, routage du signaling, jetons, CONFIG, kill switch, métriques | proxy vidéo, stockage/transit de segments, accès fournisseurs |
| Client (mesh) | RTCPeerConnection, DataChannels, scoring local, cache IndexedDB, requêtes segments | toucher à l'URL signée du proxy (fallback transparent) |
| API existante | délivrer le meshToken avec le play URL | embarquer de la logique mesh (rester ADR-0002) |

### Choix techniques et rejets

1. **WebRTC DataChannel natif + perfect negotiation maison** (~300 l.).
   *Rejetés* : simple-peer (dépendance multi-pairs mal adaptée au fan-out
   plafonné), WebTorrent (modèle tracker incompatible avec l'autorisation par
   swarm signé), libraries managées (coût, lock-in). MSFS (MediaSource
   Extensions) écarté : trop de contraintes navigateurs vs. DataChannel
   universellement supporté là où MSE existe.
2. **Durable Objects pour la coordination**, à l'imitation de
   `SegmentCoordinator` (déjà déployé). Plan gratuit → classes **SQLite**
   obligatoires (`new_sqlite_classes`, cf. wrangler du video-proxy).
   *Rejetés* : KV (latence et pas de consistance par swarm), Postgres chaud
   (Neon/Hyperdrive = la base du métier, pas une file de signaling ; les
   100k req/j du plan gratuit sauteraient avec le seul heartbeat), Workers
   séparés stateless (pas de vue par swarm).
3. **WebSocket (Hibernation API) sur le DO**, repli **HTTP polling** (2-5 s,
   curseur) pour les WebView qui bloquent WS. Un seul et même protocole JSON
   (Zod, `@mbolo/contracts`, cf. `mesh.ts`) circule sur les deux transports.
   *Rejeté* : SSE (pas de montant), WebTransport (support WebView/Gecko
   insuffisant).
4. **STUN/TURN** : aucune infrastructure déployée à l'étape 2 (il n'y en a
   pas). STUN public seul d'abord, mesure du taux de connexion réel, puis
   décision TURN. Options documentées en §14 de
   `docs/architecture/meshstream.md` (Cloudflare Realtime ICE vs coturn
   auto-hébergé **hors relais**). **Interdit explicitement : faire du relais
   résidentiel un serveur TURN** — le P2P re-passerait par le goulot et
   l'annulerait. Décision reportée aux données de bêta (étape 6).
5. **swarmId et meshToken HMAC** (`MESH_URL_SECRET`, nouveau secret) plutôt
   que JWT : la famille cryptographique des URLs proxy signées est déjà là,
   sans dépendance, vérifiable sans Postgres. Le token ne dit que
   « ce peer, ce swarm, jusqu'à telle heure » — jamais d'identité persistante
   (cf. `peerId` = 16 octets aléatoires par session de lecture, jamais dérivé
   du deviceId ; `did` = HMAC quotidienne, pas deviceHash brut).
6. **Intégrité des segments en 3 couches** (pas de hash origin : il n'existe
   pas, vérifié dans le code) : (a) `SEGMENT_COMPLETE {sha256}` calculé par
   l'émetteur → détecte troncature/corruption ; (b) `HELLO {sid, rid}` et
   fenêtre bornée → détecte le cross-swarm ; (c) `decode + byteLength` à
   l'assemblage côté demandeur. Limites assumées : un pair malveillant peut
   servir des octets valides-cryptographiquement-mais-faux ; la détection est
   heuristique (MSE decode failure → peer marqué UNRELIABLE + purge).
7. **Règle de repli structurale** : buffer sous le seuil critique OU live edge
   dans les N derniers segments → **origin, sans pari peer**. Timeout peer
   1,5 s. Une vidéo qui ne joue pas est plus mauvaise qu'une vidéo qui passe
   temporairement par l'origin ; le P2P n'est jamais bloquant.

## Modèle de swarm (résumé — détail dans docs/architecture/meshstream.md)

`swarmId = trunc128(HMAC(MESH_URL_SECRET, "mswarm|1|" + sourceId + "|" +
channelId + "|" + variantId + "|" + ecoFlag + "|" + streamEpoch))` — des
clients de swarms différents ne peuvent par construction pas partager de
segments incompatibles (le `maxh` du proxy rend les octets éco et HD différents :
ils sont dans des swarms différents). **`streamEpoch` est résolu à l'étape 3
comme étant `variantId` lui-même** (vérifié dans `importer.js` : l'id d'une
variante survit aux ré-imports — seul le locator est mis à jour — ; un vrai
changement de source crée un nouveau `variantId`). Aucune colonne supplémentaire,
aucune fragmentation : la rotation d'URL fournisseur ne rend PAS les segments
incompatibles (même média sequence live), elle ne doit donc PAS changer de
swarm. La rendition ABR (`rid`) est un champ de message, jamais du swarmId
(sinon chaque montée de qualité changerait de swarm). Le changement de
qualité éco↔HD recalcule un swarmId : on quitte l'ancien, on rejoint le
nouveau, la lecture continue via l'origin.
Fan-out plafonné (défaut 4, dur 6) → le graphe est borné, jamais full-mesh :
à N=1000, ≈ 4000 liens, pas 500 000.

## Sécurité

Autorisation par le meshToken (lié DeviceGrant, court, pair↔swarm précis) ;
le coordinateur ne transporte que des messages < 8 Ko validés Zod stricts ;
les pairs sont explicitement non fiables (bornes de taille, quotas,
hash-à-l'émission, fenêtre ± bornée, pas d'URLs échangées — uniquement des
bytes et des `(cc, sn)`) ; `SWARM_FULL`/rate-limit par `did` ; KICK/DRAIN
pilotables. Le partage n'existe que pour les sources dont la licence le
permet : `p2pEnabled` au niveau `Source` (étape 3), kill switch global par
`CONFIG.p2pEnabled=false`. Confidentialité : aucune IP brute, aucun nouveau
champ personnel en base ; les tables chaudes sont le SQLite du DO, éphémères.

## Coûts et limites

- DO gratuites = SQLite + 100k req/j : 200 pairs × heartbeat 30 s ≈ 576k
  msg/jour → **plan Pay-as-you-go (~5 $/mois) nécessaire dès le bêta public**.
- TURN futur : facturé au volume ou à maintenir ; non chiffrable avant mesure.
- CPU/RAM clients : pair « normal » ≈ 2-5 % CPU, ~50 Mo ; Android TV →
  `capacity=off` par défaut.
- Le gain bandwidth est un déplacement de coût (proxy → pairs), pas une
  suppression ; le relais garde son rôle amont.

## Stratégie de rollout

1. **Étape 2** — contrats + spec. ✅ fait.
2. **Étape 3** — worker mesh + émission de jetons API derrière `MESH_ENABLED`.
   ✅ **code écrit** (worker non déployé : il ne tourne qu'avec un `wrangler
   deploy` manuel + secrets).
3. **Étape 4** — client `@mbolo/mesh` + Player (loader, pairs, cache mémoire,
   signalisation WS/poll, garde de non-blocage). ✅ **code écrit**, tests sous
   mocks.
4. **Étape 5** — cache persistant IndexedDB + scoring EWMA + sélection adaptative
   + backoff + télémétrie + kill-switch réversible + activation par source
   (allowlist env). ✅ **code écrit**, tests sous mocks (108 cas mesh, 41 cas
   worker). **NON testé en navigateur réel.**
5. **Étape 6** — données de connectivité RÉELLES → décision TURN. ⛔ reporté
   (n'est possible qu'après un déploiement + une vraie audience).
6. **Étape 7** — durcissement, quotas, `/_stats` mesh étendus, colonne
   `Source.p2pEnabled` (migration Prisma) remplaçant l'allowlist env. ⛔ à venir.

**Déploiement réel et test sur 2-3 appareils (owner) = pré-condition à la
validation de l'étape 4/5 en conditions réelles ; rien de ce document ne
prétend que le P2P inter-machines a été observé fonctionner.**

À chaque marche : `p2pEnabled=false` (global `MESH_KILL_SWITCH`, par source via
`MESH_SOURCE_ALLOWLIST`, ou par CONFIG) ramène instantanément au comportement
actuel, sans redéploiement.

## Conséquences

- `packages/contracts` s'agrandit de `mesh.ts` (schémas du protocole v1, des
  jetons, de la config — dont la config de scoring `meshScoreConfigSchema` et les
  constantes de budget du cache persistant `MESH_PERSIST_*`, source unique des
  nombres) et de trois champs optionnels dans `PlayResponse` ; rien de consommé
  par le streaming actuel quand les flags sont absents.
- Le worker `mbolo-tv-mesh` (étape 3) et le package client `packages/mesh`
  (étapes 4-5) **existent** ; ils sont écrits et testés sous mocks, non déployés.
  Le client ajoute à l'étape 5 : `persistent-cache.ts` (IndexedDB via
  `idb-keyval`, LRU + TTL + budget, auto-désactivant), `peer-score.ts` (EWMA
  local, pénalités/cooldown/réhabilitation), sélection par score + diversité
  déterministe dans `peer-manager.ts`, hiérarchie mémoire→IDB→pairs→origin +
  backoff dans `mesh-loader.ts`, seed persistant + kill-switch pause/reprendre +
  `STATS_REPORT`/`FALLBACK_PING` dans `mesh-client.ts`.
- **Aucune migration Prisma** : l'activation par source reste l'allowlist env
  `MESH_SOURCE_ALLOWLIST` (l'abstraction `sourceAllowed()` est le point de
  branchement futur d'une colonne `Source.p2pEnabled`, étape 7). Aucune table
  de membership n'est ajoutée : le Durable Object reste la source de vérité temps
  réel (§42/§46).
- Le document normatif détaillé est `docs/architecture/meshstream.md`
  (swarm, peer, token, segment, protocole, states, config, erreurs,
  compatibilité).
- **Statut de validation** (honnête) : *implémenté* = code écrit ; *testé sous
  mock* = couverture par les suites Node (WebRTC/IndexedDB/WS simulés) ; *testé
  navigateur réel* = **néant pour l'instant** ; *non testé* = ICE réel sous CGNAT,
  quota réel IndexedDB, comportement iOS/Android TV. Le P2P inter-appareils
  n'a **jamais** été observé en conditions réelles.
