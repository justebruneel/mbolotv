# Signature des URL du proxy vidéo

## Problème

Le proxy edge (`workers/mbolo-tv-video-proxy`) acceptait historiquement
n'importe quel `?url=<ce-qui-est-demandé>` : un **relais ouvert** exploitable
par des tiers (abus de bande passante Cloudflare, anonymisation, relais de
contenu arbitraire sous les domaines mbolotv).

## Mécanisme

Toute URL proxifiée porte désormais une signature HMAC-SHA256 :

```
https://<proxy>/?url=<fournisseur encodé>&x-exp=<expiry ms>&x-sig=<hex 64>
```

- **Payload signé** : `<url>|<expiry>` — l'URL cible ET l'expiry sont couverts.
- **Secret partagé** : `PROXY_URL_SECRET`, identique sur le worker API et le
  proxy. Jamais commité (voir « Déploiement »).
- **Expiry par créneau horaire** : `floor(now / 1h) * 1h + 24h`. Deux effets :
  - une URL reste valide ~24 h (sessions longues OK, y compris iOS natif qui
    réutilise l'URL du manifest maître pendant toute la lecture) ;
  - tous les utilisateurs d'une même heure obtiennent **la même signature**
    pour la même URL fournisseur → les clés de cache segments du proxy restent
    mutualisées entre utilisateurs.
- **Réécriture des playlists** : quand le proxy réécrit un manifest, il
  re-signe chaque URL enfant (variantes, segments, pistes audio `#EXT-X-MEDIA`,
  clés `#EXT-X-KEY`) avec le même schéma. La chaîne complète reste signée de
  bout en bout.
- **Refus** : `403` (absente, expirée, invalide), `400` (URL invalide),
  `403` (schéma non http/https), `503` si le proxy n'a pas de secret configuré.

`maxh` (plafond Éco) et `direct` (VOD) ne sont pas signés : ils ne peuvent
que réduire la qualité ou changer le chemin de sortie, jamais élargir l'accès.

- `maxh=<h>` : filtre les variantes du master au-delà de `h` pixels (éco).
- `direct=1` : sortie **directe Cloudflare** — le relais résidentiel est
  court-circuité (hôtes RELAY_MAP/RELAY_DOMAIN_MAP compris), avec repli
  unique via le relais si le fournisseur refuse les IP datacenter. Utilisé
  pour le VOD (`/api/vod/:id/play`) : les fichiers mp4/mkv, lourds et
  fortement seekés, ne doivent pas transiter par la ligne résidentielle.
  Cache binaire long TTL (1 h, immutable) au lieu du TTL segment court.
  `direct` fait partie de la clé de cache (un fetcher direct n'impose pas
  son egress aux viewers en relais).

## Déploiement (l'ordre compte)

1. Générer un secret fort et le poser sur les **deux** workers :

   ```bash
   openssl rand -hex 32   # valeur à conserver
   npx wrangler secret put PROXY_URL_SECRET --name mbolo-tv-api
   npx wrangler secret put PROXY_URL_SECRET --name mbolo-tv-video-proxy
   ```

2. Déployer **l'API d'abord** (`workers/mbolo-tv-api`) : elle émet alors des
   URL signées que l'ancien proxy ignore volontairement (params inconnus
   sans effet) — compatibilité totale pendant la fenêtre de transition.
3. Déployer ensuite **le proxy** (`workers/mbolo-tv-video-proxy`) : il commence
   à refuser les requêtes non signées.

Rollback inverse : redeployer l'ancien proxy (tolérant), puis l'ancienne API.

En local (`wrangler dev`), renseigner `PROXY_URL_SECRET` dans le `.dev.vars`
de chaque worker (même valeur), hors git.

## Rotation du secret

Poser le nouveau secret sur les deux workers quasi simultanément puis
redéployer. Les lectures en cours utilisent des URL déjà signées avec
l'ancien secret : elles cassent au prochain rechargement de playlist après
le basculement (≤ quelques secondes de rupture par lecteur actif). Préférer
une fenêtre creuse.

## Limites connues

- Une URL signée obtenue légitimement reste réutilisable jusqu'à son expiry
  (~24 h) — cohérent avec les jetons fournisseurs eux-mêmes longs. L'expiry
  court-circuite surtout les liens fuirés.
- Le secret est stocké côté client final ? Non : il ne transite jamais dans
  l'app web ; le navigateur ne voit que des URL déjà signées venues de `/play`.
