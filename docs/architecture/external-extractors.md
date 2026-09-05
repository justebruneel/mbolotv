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
| Voe | `/e/{id}` → JSON `application/json` → ROT13 → séparateurs → atob → −3 → reverse → atob → JSON (`source` HLS préféré) | URL complète (miroir quelconque) ou code nu | ✅ validé live (master HLS + probe + titre) |
| Uqload | `/embed-{id}.html` → packer Dean Edwards → `file:[{file}]` (HLS) | URL complète ou code nu | ⚠️ extraction validée live, probe 403 nginx (IP datacenter — à confirmer via relais) |

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

## Stockage : ExternalTitle + ExternalSource

Migration `20260906000000_add_external_titles` (Prisma + SQL brut Worker) :
- `ExternalTitle` (global comme `VodFolder`) : site, siteRef (ex. newsid),
  titre, année, affiches, trailer — unique(site, siteRef).
- `ExternalSource` : titleId (cascade), host, embedUrl, finalUrl (wrapper
  suivi), versions[], sortOrder, isActive, lastStatus
  (`UNKNOWN|OK|DEAD|ERROR`), lastError, lastCheckedAt.
- Aucun lien direct éphémère stocké : la lecture repasse toujours par
  `/api/x/play` (résolution au clic).

## Console : coller fiche → aperçu → publier

Page Catalogue VOD, section « Titres externes » :
1. Coller l'URL → `GET /api/owner/vod/external/preview` (aperçu métas +
   lecteurs, cases cochées = hosts extractibles).
2. Publier → `POST …/external/publish` : re-scrape, **probe chaque lecteur**,
   crée le titre (dédupe site+siteRef) et les sources saines ; les morts sont
   rejetés avec motif, jamais stockés.
3. Gestion : visibilité, activation, réordonnancement, **revérification
   immédiate**, suppressions (titre = cascade sources). Audit `vod.external_*`.
4. Public app (futur lecteur) : `GET /api/x/titles`, `GET /api/x/titles/:id`
   (sources actives OK/UNKNOWN + `playRef` pour `/api/x/play`).

## Santé continue (cron)

Slot `*/10` du Worker : `checkExternalBatch(env, 8)` — les 8 sources actives
les moins vérifiées, en séquentiel (pas de rafale anti-bot), statut persisté.
Le lecteur bascule sur les sources saines ; les `DEAD` sortent du catalogue
public mais restent gérables en console.

## Parité Nest (auto-hébergé)

Modèles Prisma + migration partagés. Nest couvre CRUD/gestion et lectures
publiques (`ExternalController` `/api/x/titles*`, endpoints owner Prisma).
Aperçu/publication/revérification (scrape + probe = code Worker) répondent
**501** explicite : le flux d'import complet tourne sur le Worker.
- Quand un host casse (player changé) : le symptôme est `DEAD`/`wurl` absent —
  mettre à jour l'adapter seul, kill-switch = retirer du registre.
