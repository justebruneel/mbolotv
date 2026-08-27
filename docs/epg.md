# EPG & Métadonnées TMDB — Mbolo TV

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
TMDB_API_KEY=xxx   # https://www.themoviedb.org/settings/api — v3 API Key
TMDB_READ_TOKEN=eyJ... # Bearer v4 (optionnel, préféré)
```

- `TMDB_API_KEY` **ou** `TMDB_READ_TOKEN` suffit. Jamais exposé frontend (`NEXT_PUBLIC_` interdit). Si absent, enrichissement désactivé, EPG reste fonctionnel (fallback affiche `imageUrl` d’origine + `Programme temporairement indisponible` si besoin).
- `EPG_*_URLS` : liste d’URLs séparées par virgule. Laisser vide = désactive le layer.

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
- **TMDB** : table `TmdbCache` (`cacheKey = lower(title)::year`, `payload JSON`, `expiresAt +30j`), index `expiresAt`. Évite recherches répétées `"Avatar"` 1 seule fois. Si `type` = `sports|news|kids` → skip TMDB (quota).
- **Images** : URLs CDN `https://image.tmdb.org/t/p/w500|w1280` direct en `<img loading="lazy">`, pas de téléchargement.
- **Frontend** : `useChannelEpg stale 5min`, `useInfiniteChannels placeholderData keepPreviousData`, `ProgrammeProgress` tick 30s.

## 7. Enrichissement TMDB

Flux : `EPG brut → normalizeCategoryToType → enrichBatch (50 prime 19-23h) → TmdbProvider.search(title,year) → poster/backdrop/overview/genres/year/trailer → cache 30j → EpgProgramme.metadata.tmdb`.

Attribution obligatoire affichée `watch` + `epg` : *This product uses the TMDB API but is not endorsed or certified by TMDB.* + logo si possible.

## 8. Limitations

- TMDB gratuit 40 req/10s, pas de SLA, `search` peut confondre homonymes (on privilégie année si dispo).
- iptv-epg.org `testing only`, pas de SLA.
- `globetvapp` 1-4 fichiers/pays à merger manuellement.
- `.xz` non supporté (on n'utilise que `.gz`).
- Worker Cloudflare `workers/mbolo-tv-api` n'exécute pas encore `EpgOrchestrator` (seul Nest `apps/api` le fait) — en prod Worker, seul Xtream tourne. Porter `epg-orchestrator` vers `workers/src/epgimport.js` si déploiement 100% Workers.

## 9. Choix EPG pour Mbolo TV (recommandé MVP)

- **MVP 0€** : Xtream + XMLTV.fr + iptv-epg.org + globetvapp → FR 95%, Afrique 70%.
- **Recommandé 24€/an** : MVP + epg.best 250ch → Afrique 85-90%.

## 10. Opérations

- Import complet : `POST /api/epg/import` ou cron 05:00 `EpgImportService.run()`
- Vérifier couverture : `GET /api/epg/providers` + logs `unmatchedSample`
- Purge cache TMDB expiré : cron `DELETE FROM "TmdbCache" WHERE "expiresAt" < now()` (à ajouter si besoin)
