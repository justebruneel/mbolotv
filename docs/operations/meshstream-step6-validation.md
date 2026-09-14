# Étape 6 — Validation physique MeshStream (runbook opérateur)

**Statut de ce document :** protocole d'exécution + tables de relevés.
Ce qui est **déjà prouvé sans appareils** (juistifié dans le rapport d'étape) :
déploiement réel du worker mesh, batterie d'authentification §6 sur l'edge
Cloudflare réel (7/7), livraison des refus en mode polling (bug trouvé ET
corrigé pendant cette étape), kill-switch live ON→OFF, télémétrie `[mesh-test]`
instrumentée et testée anti-fuite. **Ce document couvre ce qui exige DEUX
VRAIS APPAREILS** (§7-§20) — rien ici ne doit être déclaré « validé » sans
relevé physique.

---

## 0. Matrice d'isolation (règle : UNE source, des appareils autorisés)

| Niveau | Clé | Valeur de test | Effet si absent |
|---|---|---|---|
| API émet des jetons | `MESH_ENABLED` | `"1"` (uniquement worker de test §1) | `/play` = réponse actuelle, champ `p2p` absent |
| Source unique | `MESH_SOURCE_ALLOWLIST` | `csv-sourceId-éco-test` (JAMAIS `*`) | aucune source → `p2p:false` |
| Secret partagé | `MESH_URL_SECRET` | IDENTIQUE API ↔ mesh | refus d'émission |
| Front de test | `NEXT_PUBLIC_MESH_POC` | `"1"` sur preview Vercel (jamais prod) | chunk mesh jamais chargé |
| Consentement upload | localStorage `mbolo:mesh-cap` | posé MANUELLEMENT par appareil de test | `off` = consommateur pur |
| Coupe-circuit | `MESH_KILL_SWITCH` | `"1"` pour §13 | normal |

Vérification avant tout : `curl -s <API>/api/...` → réponse SANS `p2p` quand
`MESH_ENABLED` absent (test API `mesh-play.test.mjs` le fige déjà).

## 1. Environnement de test isolé (recommandé : API séparée, prod intacte)

Option **A — recommandée** : déployer l'API sous un nom distinct (le code de la
branche mesh est additif ; sans les vars il est inerte, mais on évite de
toucher l'API de production pendant un test) :

```bash
cd workers/mbolo-tv-api
# dans wrangler.toml, TEMPORAIREMENT pour le test seulement : name → "mbolo-tv-api-meshtest"
# (ou utiliser un env wrangler ; ne PAS commitier ce changement)
npx wrangler secret put MESH_URL_SECRET   # même valeur que le mesh worker (workers/mbolo-tv-mesh/.dev.vars)
npx wrangler deploy
npx wrangler secret put MESH_ENABLED --value-stdin <<< "1"   # ou wrangler vars
npx wrangler secret put MESH_PUBLIC_URL --value-stdin <<< "https://mbolo-tv-mesh.mbolo-tv-video-proxy.workers.dev"
npx wrangler secret put MESH_SOURCE_ALLOWLIST --value-stdin <<< "<sourceId-éco-test>"
```

Puis un **preview Vercel** (jamais la prod) avec :
`NEXT_PUBLIC_API_URL=<url-api-meshtest>`, `NEXT_PUBLIC_MESH_POC=1`.
Ajouter l'origine du preview aux CORS du mesh worker :
`npx wrangler deploy --var "CORS_ALLOWED_ORIGINS:https://mbolotv-web.vercel.app,https://preview-xxxx.mbolotv-web.vercel.app"`
(ou éditer `workers/mbolo-tv-mesh/wrangler.toml` — le WS n'est pas soumis au
pré-vol ; seul le polling en a besoin).

Choisir la chaîne éco de test : une source **dont la licence autorise le
test**, variante éco active. L'appareil A ouvre la chaîne, lit
`swarm=` tronqué dans `[mesh-test]`.

## 2. Pré-vol rapide avant les appareils

```bash
cd workers/mbolo-tv-mesh
MESH_URL_SECRET=… node scripts/mesh-remote-check.mjs https://mbolo-tv-mesh.mbolo-tv-video-proxy.workers.dev
# attendu : 7/7 preuves OK (§6 complet : JOIN, cap=off jamais candidat, rid
# divergent, usurpation, kill OFF). Si un seul FAIL → STOP, diagnostiquer.
```

## 3. Protocole §7-§11 — deux appareils

**Appareil A** (desktop Chrome/Edge ou Android Chrome) : ouvrir le preview,
chaîne éco, console devtools → filtrer `[mesh-test]`. Pour SEEDER :
`localStorage.setItem('mbolo:mesh-cap','normal')` puis recharger (consentement
expliquée §39). Attendre 30-60 s (≥ 8 segments bufferisés).

**Appareil B** : même chaîne (même rendition — vérifier la qualité sélectionnée
identique). Sans la clé localStorage → consommateur pur (capacity off).

Relevés à capturer (copier le JSON de `window.__meshTest.dump()` de CHAQUE
appareil, plus les lignes `[mesh-test]` `{t:'tier'…}`) :

| Champ | Source | A | B |
|---|---|---|---|
| segments `tier:'peer'` | dump `peerHits` | | |
| segments `tier:'origin'` | dump `originHits` | | |
| hits mémoire / IDB | dump `memoryHits`/`persistentCacheHits` (NE COMPTENT PAS dans peer_ratio §11) | | |
| octets peer/origin | dump `bytesFromPeers`/`bytesFromOrigin` | | |
| `peer_ratio` | dump `peerHitRate` | | |
| offload | dump `meshOffload` | | |
| moyennes de latence | moyenne des `peerResult.ms` vs `tier:'origin'.ms` | | |

**Preuve de transfert RÉELlement peer (§10.7)** : sur B, une ligne
`{t:'peerResult',ok:true,bytes:NNNN}` et la ligne `{t:'tier',tier:'peer'}` qui
suit sur le MÊME `(cc,sn)`, SANS `tier:'origin'` pour ce segment.

**Classification ICE (§9)** : pour chaque lien (événement `{t:'ice'}` +
`{t:'candidatePair'}`) :

| Cas | Signe |
|---|---|
| DIRECT | `candidatePair` local=`host` remote=`host` (même réseau) |
| STUN_SUCCESS | `ice:connected` + paire avec `srflx` |
| FAILED | `ice:failed` répété (compter les tentatives ; vérifier les compteurs mesh `/_stats`) |
| TURN_NOT_AVAILABLE | FAILED alors que seul STUN est configuré — NOTER, ne pas conclure |

## 4. §12 — disparition du pair

A seede, B consomme (peerHits > 0 d'abord). Puis sur A, dans l'ordre, un cas
par test : (1) fermer l'onglet ; (2) couper le Wi‑Fi 10 s ; (3) arrière-plan
mobile ; (4) tuer le navigateur. Sur B : mesurer le trou de lecture
(apparence d'un stall > 1 s ?) et relever les lignes `[mesh-test]`.

**CRITÈRE DURE** : `peerResult` en échec → `tier:'origin'` sous ≤ timeout
(1,5 s défaut) + aucun buffer critique visible. Si B s'arrête > 5 s → STOP,
bug à corriger avant toute suite (principe §22 : le peer ne bloque JAMAIS).

## 5. §13 — kill-switch avec deux appareils connectés

```bash
printf '1' | npx wrangler secret put MESH_KILL_SWITCH    # mesh worker
```
Dans les 30-60 s (alarme DO) : les deux consoles `[mesh-test]` doivent loguer
`{t:'kill',enabled:false}`, les `peerHits` cessent, la lecture continue.
Puis rouvrir : `npx wrangler secret delete MESH_KILL_SWITCH` (⚠️ valider la
suppression : `wrangler secret list` doit être vide — une suppression ratée a
été observée avec cette étape en test). Reprise attendue : `{t:'kill',
enabled:true}` + re-JOIN + nouveaux `peerHits`, SANS recharger les pages.

## 6. §14 — capacité

Sur B : `off` (défaut, aucun relevé d'upload côté B) ; `low` puis `normal` via
la clé localStorage. Vérifier côté A `bytesServed`/`{t:'peerResult' bytes>0}`
uniquement quand le PEER qui sert a consenti. Aucun appareil ne doit émettre
sans la clé posée manuellement.

## 7. §15 — montée en charge 2 → 3 → 5

Ajouter des appareils un par un (maxPeers 4 défaut, dur 6) : vérifier
`peers ≤ 4` par lien dans `[mesh-test]`, CPU/mémoire (devtools Performance),
stabilité. En cas de dégradation : retirer un appareil, documenter.

## 8. §16 — Android / Android TV / WebView

Par appareil : relever les capacités détectées (`detectMeshCapabilities` est
loggé implicitement par l'absence/présence du chunk). Android TV : capacité
par défaut OFF (§39), tester RECEPTION seulement. GeckoView : valider
séparément, ne pas extrapoler depuis Chrome desktop.

## 9. §17 — CGNAT

Matrice mini (2 réseaux obligatoires) : A=wifi maison, B=data mobile 4G/5G ;
inverser ; si possible un 3ᵉ réseau (autre FAI). Taux :
`ice_success_rate = (DIRECT + STUN_SUCCESS) / tentatives` sur les paires de
lignes `{t:'ice', state.ice:'connected'|'failed'}`. **Ne pas décider TURN sur
< 10 tentatives** — c'est l'étape 6B sur données.

## 10. Rollback / teardown (à tout moment, sans redéploiement)

1. `MESH_KILL_SWITCH="1"` → mesh neutre côté clients (lecture intacte).
2. API de test : retirer `MESH_ENABLED` → plus aucun jeton émis.
3. Front : preview sans `NEXT_PUBLIC_MESH_POC` → chunk mesh jamais chargé.
4. Fin de test : `npx wrangler delete --name mbolo-tv-api-meshtest` ;
   effacer le worker mesh OU le garder inerte (kill + pas de secret = 401).
5. Vérifier prod inchangée : `/play` sans `p2p`, aucun `[mesh-test]` possible.

## 11. Table de décision TURN (§20) — à remplir

| Test | Réseau A | Réseau B | ICE | Pair (local/remote) | Résultat |
|---|---|---|---|---|---|
| A→B | wifi | wifi | | | |
| A→B | wifi | data mobile | | | |
| B→A | data | wifi | | | |
| … | | | | | |

`ice_success_rate = ___` ; si ≥ seuil utile (≈ 60-70 %, jugé sur données
réelles, pas arbitrairement) → ne PAS installer TURN ; sinon → ÉTAPE 6B.
```
