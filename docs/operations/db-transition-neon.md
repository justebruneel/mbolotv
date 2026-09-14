# Transition base de données — Neon → PostgreSQL local → Neon

**Contexte** : le 12 septembre 2026, le projet Neon gratuit a dépassé son quota
de transfert mensuel (5 Go). Neon refuse les connexions (« exceeded the data
transfer quota ») jusqu'à la remise à zéro du cycle de facturation (≈ 1er
octobre). Le quota **stockage** (0,5 Go/projet) n'était pas atteint : les
données Neon sont intactes, seulement inaccessibles.

## Architecture provisoire (jusqu'au retour sous Neon)

```
Worker mbolo-tv-api (Cloudflare)
  │  env.DB_GATEWAY_URL + secret DB_GATEWAY_TOKEN
  ▼ HTTPS POST {sql, params}
edge Cloudflare → tunnel cloudflared « relay-dns » (cette machine, systemd --user)
  ▼ http://127.0.0.1:8086
Passerelle SQL HTTP  scripts/db-gateway.mjs (systemd --user mbolo-db-gateway)
  ▼ localhost:5432 (scram-sha-256, serveur en UTC)
PostgreSQL 18 local — base « mbolo », rôle applicatif « mbolo »
```

Le protocole wire PostgreSQL ne peut pas traverser l'edge Cloudflare (port 443
= TLS/HTTP uniquement ; Hyperdrive émet un SSLRequest libpq que l'edge
 interprète comme une requête invalide — d'où le message « Unknown message
code: H » lors du test Hyperdrive → tunnel TCP). La passerelle HTTP est le
seul chemin 100 % gratuit sans carte bancaire ; elle sera retirée au retour
Neon, sans toucher le reste du code (un seul point de branchement : `src/db.js`).

## Pièces en place

| Élément | Emplacement |
|---|---|
| Schéma (23 migrations Prisma) | reconstruit intégralement — `packages/db/prisma/migrations` |
| Compte owner | `scripts/bootstrap-owner.mjs` (email/mot de passe du `.env` racine) |
| Passerelle SQL | `workers/mbolo-tv-api/scripts/db-gateway.mjs` · systemd --user `mbolo-db-gateway.service` · env `~/db-gateway.env` (600) |
| Ingress tunnel | `hostname: db-api.mbolotv.dpdns.org → http://127.0.0.1:8086` dans `~/relay-dns/config.yml` |
| Worker | var `DB_GATEWAY_URL` (`wrangler.toml`), secret `DB_GATEWAY_TOKEN`, version déployée courante |
| Dev local | `npm run dev` (la chaîne Hyperdrive locale est lue dans `packages/db/.env`, jamais commitée) |
| Sauvegardes | `~/bin/mbolo-db-backup.sh` → `~/db-backups/mbolo-*.dump` (rétention 7 j) — **à planifier** (`crontab -e` : `17 4 * * * ~/bin/mbolo-db-backup.sh`) |
| PostgreSQL | systemd `postgresql.service`, `enabled` — redémarre avec la machine |

## Ce qui reste à faire côté exploitant

1. **Re-créer les sources** dans la console owner (les identifiants chiffrés
   vivaient dans la base Neon, toujours gelée) : les imports et le bot
   repeupleront catalogue, VOD et EPG automatiquement.
2. **Émettre de nouveaux codes d'accès** (les anciens et les DeviceGrants
   restent dans Neon et seront rapatriés au retour).
3. Planifier la sauvegarde quotidienne (cron ci-dessus) et tester la
   restauration au moins une fois : `pg_restore -d mbolo_test <dump>`.
4. Le conteneur Docker `mbolotv-api` (Nest de référence) a été **stoppé**
   (il tournait en boucle de crash sur Neon). Pour le repasser en local,
   mettre à jour son `DATABASE_URL` vers `postgresql://mbolo:***@172.17.0.1:5432/mbolo`
   (pont Docker, règle pg_hba déjà en place) puis `docker compose up -d`.

## Retour sous Neon — checklist (≈ 1er octobre)

1. Vérifier que Neon répond à nouveau (page Usage de la console).
2. **Rapatrier les données** accumulées localement et l'ancienne base Neon :
   la base d'origine contient codes d'accès/grants/favoris/historiques
   précieux ; la base locale contient sources recréées + imports. Faire la
   fusion à la main (ou re-saisir) : `pg_dump` des deux, restauration croisée
   sur un Postgres jetable, puis `pg_restore` vers Neon.
3. `packages/db/.env` : décommenter la ligne `DATABASE_URL` Neon, commenter la ligne locale.
4. `wrangler hyperdrive update <id> --origin-host ep-mute-... --origin-port 5432 --database neondb --origin-user neondb_owner --origin-password '***'`
   (id du binding : `75d74bf3c4b24e36ab9666697030b0fb`).
5. Retirer `DB_GATEWAY_URL` de `[vars]` dans `wrangler.toml` et
   `wrangler secret delete DB_GATEWAY_TOKEN`, puis `wrangler deploy` :
   `src/db.js` retombe sur le binding HYPERDRIVE sans autre modification.
6. Tests : `GET /api/health` (SELECT 1 réel), login owner via la console,
   `/api/categories`.
7. Démonter la transition : `systemctl --user disable --now mbolo-db-gateway`,
   retirer l'ingress `db-api...` de `~/relay-dns/config.yml`, redémarrer le
   tunnel, supprimer `db-api.mbolotv.dpdns.org` (DNS), garder PostgreSQL local
   (dev) mais remettre `listen_addresses = 'localhost'` et retirer la ligne
   `172.16.0.0/12` de `pg_hba.conf`.

## Débit et garde-fous

- ~0,5 s de latence par requête (aller-retour Libreville↔Marseille via
  l'edge) : acceptable pour la console et les flux (peu de requêtes
  par page). Les gros imports cron peuvent traîner : si un import dépasse
  son budget, le cron de reprise (`*/2`) le relance — rien ne se perd
  (upserts idempotents).
- **Budget de sous-requêtes** : avec Hyperdrive, les requêtes SQL passaient
  par un binding et ne comptaient pas ; avec la passerelle, chaque requête
  est une `fetch` et compte dans le quota Cloudflare (50 par invocation sur
  le plan gratuit — non configurable sans passer au plan payant, `[limits]`
  est rejeté au déploiement). Conséquences traitées : semis du bot regroupé
  en un `INSERT` multi-lignes par page (`seedQueue` dans `src/external-bot.js`)
  au lieu d'un par item ; `EXTERNAL_BOT_BATCH` réduit à 1 ; et **import des
  séries suspendu** pendant la transition (`kindGuard` dans le claim — une
  fiche série = ~20 INSERT d'épisodes, hors budget) : les ~450 séries restent
  PENDING en file et repartent seules au retour Neon (disparition de
  `DB_GATEWAY_URL`). Le cron bot logge un compteur `sql:` (`env.__gwCount`)
  pour vérifier le budget au tail. Toute nouvelle boucle SQL dans un cron
  doit être pensée « une seule requête » (multi-row `VALUES`, `unnest`, ou
  `statements` groupés — la passerelle accepte un tableau de statements en
  un seul aller-retour).
- Le passeur refuse tout corps > 2 Mo, > 200 statements par requête,
  statement_timeout 25 s, pool ≤ 8 connexions, écoute uniquement sur
  127.0.0.1 et exige le jeton (comparaison en temps constant).
- La machine résidentielle est déjà un point de défaillance unique (relais
  vidéo) ; si elle tombe, l'API tombe avec elle. À accepter pour la
  transition uniquement.

## Pièges corrigés pendant la transition (à garder en tête)

1. **Codec des types pg** : le JSON de la passerelle transportait les
   `timestamptz` en chaînes brutes → `grant.expiresAt.toISOString is not a
   function` partout où le code attend de vraies `Date` (codes d'accès,
   DeviceGrant, etc.). Corrigé de part et d'autre : `pgSafeReplacer` dans
   `scripts/db-gateway.mjs` (marque `__pg: date/bytes/bigint`) et `revivePg`
   dans `src/db.js` (réhydrate). Ce codec est la **condition de vie** de la
   passerelle : toute future évolution du transport SQL doit le conserver.
2. **Table `ActivityHeartbeat`** : créée à la main dans Neon, absente des
   migrations → « relation n'existe pas » sur la base neuve. Provisionnée
   désormais au runtime par `src/activity.js` (`ensureActivityTable`, même
   patron que `featured.js`) ; se recrée sur toute base neuve.
3. **Dérive cosmétique de noms** (`TmdbCache_pkey` vs `MetadataCache_pkey`,
   index `TmdbCache_*`) : `prisma migrate diff` la signale encore, sans
   impact fonctionnel. À nettoyer optionnellement avant le 1er octobre.
4. **L'importer contournait la passerelle** : `runSourceImport` ouvrait son
   propre `pg.Client` sur la chaîne de connexion **Hyperdrive** (optimisation
   « une connexion pour tout l'import ») → il parlait à la base Neon gelée,
   où aucun `ImportRun` n'existe : les imports Xtream/M3U restaient QUEUED en
   silence, éternellement repris par le cron `*/2` sans jamais avancer.
   Corrigé : en mode passerelle, l'importer utilise `query()` de `src/db.js`
   et s'arrête à un **budget de 40 requêtes SQL par invocation** (plan
   gratuit : 50 sous-requêtes) en remettant le run en QUEUED — le curseur
   déjà persisté dans `metrics` (`liveCursor`, `vodMoviesCursor`, …) permet
   la reprise exacte au tick suivant. Réglable via `IMPORT_SQL_BUDGET`.
5. **Données binaires corrompues en transit (le plus grave)** : les colonnes
   `Bytes` (`Source.connectionEncrypted`, `encryptedLocator` de
   `StreamVariant`/`VodItem`) passent par `JSON.stringify` des params — un
   `Uint8Array` y devient `{"0":123,…}` et Postgres stockait du bytea **vide**,
   sans erreur. Symptôme : « Connexion source illisible (clé de chiffrement
   différente) » à l'import. Corrigé par le codec de params symétrique
   (`paramCodec` dans `src/db.js`, `decodeParam` dans la passerelle, marque
   `__pg: bytes`). **Conséquence données** : toute source créée pendant la
   fenêtre du bug (14 sept. ~07 h → ~15 h UTC) a ses identifiants chiffrés
   perdus → **re-saisir les identifiants Xtream/M3U dans la console** (le
   catalogue VOD importé pendant cette fenêtre était encore vide : rien à
   purger). Vérifié par aller-retour réel création → révélation re-auth.
6. **Fuseau de la machine** : l'horloge système du relay est en
   **America/New_York** (d'où la mise en UTC de PostgreSQL ce matin) ; de
   plus node-pg interprétait les colonnes `timestamp without time zone`
   (défaut Prisma) en heure locale → décalage de +4 h sur les dates lues.
   Le parseur 1114/1082 de la passerelle force désormais UTC.

## Rotations à effectuer après coup (les secrets ont transité dans ce chantier)

- Mot de passe PostgreSQL local : `ALTER ROLE mbolo WITH PASSWORD ...` +
  `packages/db/.env` + `~/db-gateway.env` (redémarrer la passerelle).
- Jeton passerelle : `wrangler secret put DB_GATEWAY_TOKEN` +
  `~/db-gateway.env` + `.dev.vars`.

## Historique de l'incident (à garder pour l'après-coup)

- Cause de la panne initiale : **quota de transfert** Neon (pas le stockage,
  pas le code). Le premier suspect (déploiement du 12/09) avait été écarté
  par `wrangler tail` : chaque requête SQL expirait (« Worker hung canceled »)
  et `/api/health` mentait (connexion seule, sans requête) — l'health-check
  interroge désormais réellement `SELECT 1`.
- Le volume de transfert est à surveiller au retour Neon : candidats de
  réduction du débit — activer le query cache Hyperdrive (désactivé), cache
  négatif des correspondances de genres (re-scan 144×/jour d'items sans
  correspondance dans `applyExternalGenreMap`), purge des programmes EPG
  passés, et fin des `SELECT *` dans les boucles de cron.
