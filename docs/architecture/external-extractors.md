# Extracteurs tiers (Mixdrop, …) — lecture sans pubs ni iframe

## Principe

Rejouer le handshake du player embed **côté Worker**, au clic uniquement :
`GET /api/x/play?host=mixdrop&id=<fileId|/e/…|/f/…>` → lien CDN direct vérifié
(probe `Range`) → URL du **proxy vidéo signé** (avec `Referer` injecté, voir
`security/proxy-url-signature.md` § `x-ref`) → lecteur maison (`Player urls[]`).

Le navigateur ne touche jamais le CDN tiers (403 sans `Referer`, CORS, SNI).

## Hosts implémentés

| Host | Méthode | Entrées | Statut |
|---|---|---|---|
| Mixdrop | `/e/{id}` → `MDCore.wurl` → `mxcontent.net` signé | id nu, `/e/`, `/f/` | ✅ validé live |
| DoodStream | embed → `/pass_md5/…` → préfixe CDN + `?token=&expiry=` | URL complète (dood.*, wrappers kakaflix/kokoflix) ou code nu | ✅ pipeline validé en mock (403 datacenter depuis le sandbox — le relais résidentiel de prod contourne) |

## Ajouter un host (Voe, Uptostream, …)

1. Créer `workers/mbolo-tv-api/src/extractors/<host>.js` avec le contrat :
   - `parse(input: string) -> { id }` (lève `INVALID` si malformé),
   - `mirrorsFromEnv?(env) -> string[]` (domaines modifiables **sans déploiement**),
   - `resolve(env, ref) -> { urls, referer, title }` (probe avant de servir).
2. L'enregistrer dans `extractors/index.js` (`REGISTRY`, `SUPPORTED_HOSTS`).
3. Étendre `externalHostSchema` (`packages/contracts`) — le hook web
   `useExternalPlay(host, id)` suit sans autre changement.

Helpers partagés : `http.js` (`fetchEmbedText` cascade relais→direct,
`probeDirectUrl`), `unpack.js` (pattern P,A,C,K générique + `extractWurl`),
`errors.js` (`INVALID→400`, `RETRYABLE→502`, `QUOTA→429`, `DEAD→451`).

## Règles d'or

- **Résolution au clic, jamais en masse** : liens signés à expiry courte,
  tokens parfois à usage unique. Cache edge 1 h (`PLAY_CACHE_TTL_S`).
- **Zéro retry** : le serveur essaie déjà les miroirs ; le client ne retente
  pas (`retry: false` + `apiGet(..., false)`). L'utilisateur relance via refetch.
- **Jamais de retry sur 429/403/451** (même politique que YouTube).
- **DEAD sur tous les miroirs = source morte** → marquer, repli iframe.
- **Garde anti-exfiltration** : chaque adapter allowliste son CDN
  (ex. `mxcontent.net`) — le proxy signé ne relaie que ce qui est vérifié.
- **Route protégée** par grant actif, comme `/api/vod/:id/play`.

## Exploitation

- Miroirs : var d'env `MIXDROP_MIRRORS` (JSON ou CSV) — voir `wrangler.toml`.
- Sonde manuelle (jamais en CI) : `node scripts/probe-extractors.mjs mixdrop <id>`
  — ne logue jamais le jeton signé complet.
- Tests : `node --test workers/mbolo-tv-api/test/extractors.test.mjs`
  (fonctions pures + signatures, sans réseau ; Dood couvert en fetch mocké).
- Miroirs : `MIXDROP_MIRRORS`, `DOOD_MIRRORS` (JSON ou CSV, défauts dans le code).

## Scraper de fiches (French Stream)

- `workers/…/src/scrapers/frenchstream.js` : fiche DLE → `film_api.php?id=`
  (JSON sans auth : players premium/vidzy/uqload/dood/voe/filmoon/netu ×
  versions default/vostfr/vfq/vff) + métas HTML (`og:title`, `#film-data`).
- Wrappers kakaflix/kokoflix suivis 1 hop (redirect JS statique) ; les pages
  Dood sont résolues par l'adapter `dood` (même player). Dédupe sur
  `(host, finalUrl)` — 2 wrappers ↔ même embed fusionnés.
- `GET /api/x/fiche?url=<fiche>` : aperçu SANS écriture (même garde grant).
  Séries refusées (`INVALID`, films d'abord).
- Sonde : `node scripts/probe-fiche.mjs "<url-fiche>"`.
- Tests : `node --test workers/mbolo-tv-api/test/scrapers.test.mjs`.
- Quand un host casse (player changé) : le symptôme est `DEAD`/`wurl` absent —
  mettre à jour l'adapter seul, kill-switch = retirer du registre.
