# EPG & Métadonnées (TVmaze / Fanart.tv) — Mbolo TV

## 1. Fournisseur EPG choisi — pourquoi

| Couche | Fournisseur | URL par défaut | Rôle | Licence |
|---|---|---|---|---|
| **Layer 0** | **Xtream `xmltv.php`** (existant) | `http://host/xmltv.php?username=&password=` (dérivé de `Source.connectionEncrypted`) ou `Source.epgUrl` custom | Source la plus fidèle : 1:1 avec le fournisseur IPTV, mapping parfait. Gardé **au même niveau** que les autres (pas forcément prioritaire, cf. choix 3). | Dépend du fournisseur IPTV |
| **Layer 1** | **XMLTV.fr** `racacax/XML-TV-Fr` | `https://xmltvfr.fr/xmltv.xml.gz` (env `EPG_XMLTVFR_URL`) | France + Canal+ complet 402 chaînes, 5j, MAJ 01:55 CET, `category`, `episode-num`, `CSA`. Apache 2.0. Couvre **Europe 95%+**. | Apache 2.0 |
| **Layer 1b** | **iptv-epg.org** | `https://iptv-epg.org/files/epg-fr.xml.gz` (`EPG_IPTV_EPG_FR_URL`) | Fallback FR + Afrique large (NG 129, ZA 145, GH 120...), MAJ horaire. Gratuit sans clé, à considérer `test only` → gardé en fallback. | Non documentée, usage test |
| **Layer 2** | **globetvapp/epg** | Raw `https://raw.githubusercontent.com/globetvapp/epg/main/{Nigeria, Southafrica, …}/…xml` via `EPG_AFRICA_URLS` | Complète Afrique (CI, SN, CM, MZ…) où iptv-epg.org est faible. GPL-3.0. | GPL-3.0 |
| **Layer 3** | **epg.best** (optionnel payant) | Non configuré par défaut, à ajouter via `EPG_EXTRA_URLS` | 10k chaînes, ajout à la demande, 7j, timeshift — comble Canal+ Afrique si <70% couverture. 1.99$/m 250ch. | Commercial |

**Vérification couverture** : voir `verify-coverage` ci-dessous. Aucune API ne couvre 100% Afrique + Europe gratuitement → architecture **multi-fournisseur mergée**.

## 2. Chaînes couvertes

- **Europe** : TF1, France Télévisions, M6, Arte, Canal+ (y.c. Sport/Cinéma), beIN, RMC — via XMLTV.fr + iptv-epg.org → **~95%**.
- **Afrique** : RTG1, Gabon 24, Africa 24, Nollywood TV, A+, Novelas TV, Trace Africa — via iptv-epg.org + globetvapp → **~70% brut, 85-90% avec epg.best 250**.
- Si une chaîne reste non mappée, elle garde `Aucune programmation` sans planter, log `unmatchedSample` dans `epgimport`.

## 3. Configuration

```bash
# .env (voir .env.example)
EPG_XMLTVFR_URL=https://xmltvfr.fr/xmltv.xml.gz
EPG_IPTV_EPG_FR_URL=https://iptv-epg.org/files/epg-fr.xml.gz
EPG_AFRICA_URLS=https://raw.githubusercontent.com/globetvapp/epg/main/Nigeria/nigeria1.xml,https://raw.githubusercontent.com/globetvapp/epg/main/Southafrica/southafrica1.xml
EPG_EXTRA_URLS=https://epg.best/xmltv/your-custom.xml.gz
EPG_MAX_BYTES=536870912
FANART_API_KEY=xxx     # https://fanart.tv/get-an-api-key/ — secours image (optionnel)
SPORTSDB_API_KEY=3     # https://www.thesportsdb.com/api.php — agenda football (clé test publique « 3 »)
```

- **TVmaze ne requiert AUCUNE clé** : l'enrichissement est toujours actif.
- `FANART_API_KEY` : optionnel, active le secours image quand TVmaze n'a pas d'affiche. Si absent, fallback silencieux (texte EPG sans image).
- `SPORTSDB_API_KEY` : alimente la section « À la une · Football ». La clé publique « 3 » (tier test) renvoie peu d'événements ; créer une clé gratuite pour la production.
- `EPG_*_URLS` : liste d'URLs séparées par virgule. Laisser vide = désactive le layer.

## 4. Mapping chaînes

Ne suppose jamais `name == xmltvId`. Trois niveaux :

1. `Channel.tvgId` lower → `tvgMap` (prioritaire)
2. `ChannelEpgMapping(channelId, provider, externalId)` — table `ChannelEpgMapping` éditable via console `control/[ownerPath]/catalog` (à venir UI, actuellement via SQL `INSERT INTO "ChannelEpgMapping" ...`)
3. `normalizeName(display-name)` → `nameMap` (fallback sans accents)

```sql
INSERT INTO "ChannelEpgMapping" ("id","channelId","provider","externalId","updatedAt") VALUES (gen_random_uuid(), 'channelId', 'xmltvfr', 'TF1.fr', now());
```

## 5. Ajouter un fournisseur EPG

1. Crée `apps/api/src/modules/epg/providers/mon-provider.ts` implémentant `EpgProvider` (`providers/epg-provider.interface.ts`):
```ts
export class MonProvider implements EpgProvider {
  readonly name='mon';
  getSourceUrl(){ return 'https://…/guide.xml.gz'; }
  fetchXmltv(){ return new HttpXmltvProvider('mon', url).fetchXmltv(); }
}
```
2. Ajoute-le dans `EpgOrchestrator.getExtraProviders()` ou `EpgImportService` et dans `docs/epg.md`.
3. Frontend inchangé (`EpgService` normalise).

## 6. Cache

- **EPG brut** : table `EpgProgramme` PG, TTL 6h (cron 05h + `EpgOrchestrator` 6h). `EPG_MAX_BYTES` 512M, `SafeFetcher` 15min.
- **Metadata** : table `MetadataCache` (ex-`TmdbCache`, migrée 20260901) — `cacheKey = lower(title)::year`, `payload JSON` (`MetadataEnriched`), `expiresAt +30j`, index `expiresAt`. Évite de re-chercher une même série. Si `type` = `sports|news|kids` → skip.
- **Images** : URLs CDN `static.tvmaze.com` (posters portrait) et `r2.thesportsdb.com` (badges équipes) en `<img loading="lazy">`, pas de téléchargement.
- **Frontend** : `useChannelEpg stale 5min`, `useInfiniteChannels placeholderData keepPreviousData`, `ProgrammeProgress` tick 30s.

## 7. Enrichissement TVmaze + Fanart.tv (remplace TMDB depuis 09/2026)

TMDB exige désormais un accord commercial pour notre usage (écran public avec affiches) → remplacé par des sources gratuites.

Flux : `EPG brut → normalizeCategoryToType → enrichBatch (50 prime 19-23h) → TvmazeProvider.search(title,year) → poster/summary/genres/year/rating → cache 30j → EpgProgramme.metadata.enriched`.

- **TVmaze** (source principale, sans clé) : séries TV uniquement — `image.original` (poster portrait), `summary` (HTML → texte), `genres`, `premiered`, `rating.average`. Matching strict du nom normalisé (score > 0.7 sinon rejet) pour éviter les faux positifs.
- **Fanart.tv** (secours, clé gratuite) : si TVmaze renvoie une fiche sans image et que `externals.thetvdb` existe → `tvposter` (poster) + `showbackground` (notre « backdrop », absente de TVmaze), tri par likes.
- **Films/téléfilms** : aucune fiche TVmaze → texte EPG brut sans image, **fallback silencieux** (jamais de crash).
- **Bandes-annonces** : non disponibles sur ces sources → `trailerUrl` toujours `null`, les boutons bande-annonce disparaissent automatiquement côté UI.
- Compat lecture : `extractEnriched()` lit `metadata.enriched` puis retombe sur `metadata.tmdb` pour les anciens payloads tant que l'import n'a pas tourné.

## 8. « À la une » Football (agenda TheSportsDB)

- Cron `0 */6 * * *` (`FootballScheduleService`) : fetch `eventsnextleague.php` pour Champions League (4480), Premier League (4328), La Liga (4335), Ligue 1 (4334), Serie A (4332), Bundesliga (4331) → upsert `Match` (sport=Football, `externalId=thesportsdb:<idEvent>`, logos équipes) + liaison aux chaînes EPG dont le programme cite les équipes au voisinage horaire (±4h/-1h) → `MatchStream`.
- Le cron discovery existant (`*/15`) reste actif en complément (détection EPG pure) ; dédoublonnage par équipes normalisées.
- Affichage : `FootballFeatured.tsx` sur `/live` sous le hero — carrousel trié par priorité de compétition puis horaire, max 12, « Sur {chaîne} » → `/watch/{channelId}`. Disparaît si aucune donnée.

## 9. Limitations

- **TVmaze** : 20 req/s (délai 120 ms appliqué), séries uniquement, pas de backdrop (posters portrait), `rating.average` souvent null, pas de bande-annonce.
- **Fanart.tv** : clé gratuite requise, couverture TVDB-based (séries absentes de TVDB sans image).
- **TheSportsDB** : tier gratuit ≈ 30 req/min ; clé test « 3 » limitée à ~1 événement/ligue ; noms d'équipes en anglais (matching tolérant aux accents mais pas aux traductions).
- iptv-epg.org `testing only`, pas de SLA.
- `globetvapp` 1-4 fichiers/pays à merger manuellement.
- `.xz` non supporté (on n'utilise que `.gz`).
- Worker Cloudflare `workers/mbolo-tv-api` n'exécute pas `EpgOrchestrator` ni l'agenda football (seul Nest `apps/api` le fait).

## 10. Choix EPG pour Mbolo TV (recommandé MVP)

- **MVP 0€** : Xtream + XMLTV.fr + iptv-epg.org + globetvapp → FR 95%, Afrique 70%.
- **Recommandé 24€/an** : MVP + epg.best 250ch → Afrique 85-90%.

## 11. Opérations

- Import complet : `POST /api/epg/import` ou cron 05:00 `EpgImportService.run()`
- Vérifier couverture : `GET /api/epg/providers` (renvoie `metadataEnabled`) + logs `unmatchedSample`
- Sync agenda football manuelle : ` FootballScheduleService.sync()` (via log ou endpoint à ajouter)
- Purge cache metadata expiré : cron `DELETE FROM "MetadataCache" WHERE "expiresAt" < now()` (à ajouter si besoin)
