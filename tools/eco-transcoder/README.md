# Éco-transcodeur Mbolo TV

Réduit chaque chaîne IPTV à **~1 Mbps (480p)** côté relais résidentiel :
au lieu de relayer le flux 6-8 Mbps du fournisseur, un ffmpeg le capture,
le ré-encode (`libopenh264`, segments HLS 4 s) et le résultat part vers
Cloudflare. Gain mesuré : **~7× moins d'upload par chaîne**.

## Pourquoi

La ligne résidentielle plafonne à ~10 Mbps d'upload : 1-2 chaînes HD
max en relais direct. Avec l'éco : ~8 chaînes simultanées, chaque groupe
de spectateurs sur la même chaîne partageant un seul flux transcodé.

## Lancer

```bash
cp eco-transcoder.env.example eco-transcoder.env   # adapter ECO_TOKEN
sudo mkdir -p /var/lib/mbolo-eco && sudo chown $USER /var/lib/mbolo-eco
node server.cjs
```

En service persistant :

```bash
sudo cp mbolo-eco-transcoder.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now mbolo-eco-transcoder
```

## API

| Route | Auth | Description |
|---|---|---|
| `POST /start` `{channelId, srcUrl}` | `x-eco-token` | Démarre (ou réutilise) le transcodage d'une chaîne |
| `POST /stop` `{channelId}` | `x-eco-token` | Arrête un transcodage |
| `GET /status` | `x-eco-token` | Flux actifs, bitrate mesuré, idle |
| `GET /hls/:id/index.m3u8` + segments | public | Sortie HLS servie au proxy edge |
| `GET /health` | — | Liveness |

## Intégration

- L'API (`apps/api`) appelle `/start` avec l'URL fournisseur **déchiffrée**
  quand la lecture est demandée avec `?eco=1` (mode dataSaver du site) et
  que `ECO_TRANSCODER_URL` est configuré — sinon comportement inchangé.
- Le hostname public (`ECO_PUBLIC_URL`, ex. `eco.mbolotv.dpdns.org`) doit
  être : ① ingress cloudflared → `http://localhost:8090`, ② CNAME
  `<tunnel-id>.cfargotunnel.com`, ③ autorisé dans le proxy vidéo
  (`STREAM_ALLOWED_HOSTS`).

## Limites (prototype)

- ~1 cœur CPU par flux : 2 flux max sur le Celeron 3205U, configurer
  `MAX_STREAMS` en conséquence (10-20 sur un VPS).
- Qualité : libopenh264 sans preset fin — suffisant pour du 480p éco,
  pas pour du « premium ».
- La sortie disparaît ~30 s après un crash ffmpeg ; la lecture repasse
  alors automatiquement par le flux direct côté API.
