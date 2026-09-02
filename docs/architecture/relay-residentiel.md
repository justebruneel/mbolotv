# Relais résidentiels (sortie IPTV)

Certains fournisseurs IPTV bloquent les IP datacenter (anti-restream) : les
requêtes doivent sortir d'une ligne résidentielle. Architecture : le proxy
vidéo edge remappe les hôtes du fournisseur vers un hostname
`relay-*.mbolotv.dpdns.org` (tunnel cloudflared sur la machine locale), qui
rejoint le fournisseur depuis la maison.

## Deux montages coexistants

1. **Ingress fixe par hôte** (historique) : chaque `relay-X` pointe un
   upstream précis dans `/etc/cloudflared/config-host.yml`
   (`httpHostHeader` réécrit le Host). Un hôte = une entrée worker
   `RELAY_MAP`. Service systemd système : `cloudflared-mbolo.service`.

2. **Forwarder générique** (dnsjibre.xyz, 2026-08) : un seul ingress
   `relay-dns.mbolotv.dpdns.org` → forwarder local qui lit l'en-tête
   **`x-upstream-authority`** envoyé par le proxy et route vers n'importe
   quel hôte du fournisseur (panel ET serveurs médias). Couplé à
   `RELAY_DOMAIN_MAP` côté workers pour couvrir les domaines entiers
   (les serveurs médias `*.evorvixa.cc` sont numérotés et tournent).

## Relais par défaut : zéro config pour une nouvelle playlist

Depuis `RELAY_DEFAULT_ORIGIN` (workers api + proxy), **tout hôte fournisseur
non cartographié** sort automatiquement par relay-dns :

- priorité : `RELAY_MAP` (hôte exact) > `RELAY_DOMAIN_MAP` (suffixe domaine)
  > relais par défaut ;
- les cibles privées (RFC1918, loopback, link-local, CGNAT, `*.local`) ne
  sont jamais relayées ;
- si la machine résidentielle est injoignable, le proxy retente une fois en
  direct avant d'abandonner.

Importer une nouvelle playlist IPTV ne demande donc aucune configuration
edge — la sortie résidentielle est le comportement par défaut. La logique
partagée vit dans `workers/mbolo-tv-api/src/relay.js` (`resolveRelay`) et
dans `applyRelay` du proxy.

## Machine : services utilisateur

```
~/relay-dns/forwarder.cjs     # écoute 127.0.0.1:8085, route via x-upstream-authority
~/relay-dns/config.yml        # ingress tunnel relay-dns → 127.0.0.1:8085
~/relay-dns/relay.env         # RELAY_TOKEN (chmod 600, jamais commité)
~/.config/systemd/user/relay-dns-forwarder.service   # EnvironmentFile=relay.env
~/.config/systemd/user/relay-dns-tunnel.service
```

Tunnel dédié `relay-dns` (id 6798c0bc-…), CNAME posé via
`cloudflared tunnel route dns`. Linger activé (`loginctl enable-linger`)
pour survivre aux déconnexions.

## Authentification worker ↔ forwarder

Le forwarder exige « x-relay-token » (= secret `RELAY_TOKEN`, même valeur sur
les workers api/proxy via `wrangler secret put`, et dans `~/relay-dns/relay.env`
lu par `EnvironmentFile`). Sans jeton valide : 403. Il refuse aussi toute
autorité privée/réservée — ce n'est pas un relais ouvert vers le LAN.

## Pièce maîtresse : l'assainissement des en-têtes

Le panneau adapte ses réponses au client perçu. Quand c'est le **worker**
Cloudflare qui appelle, cloudflared injecte `cf-connecting-ip` (IP datacenter),
`x-forwarded-*`, etc. Si ces en-têtes atteignent le panneau, il dégrade la
session : redirections vers des serveurs en IP brute, jetons rafraîchis en
boucle (« Trop de redirections fournisseur »). Le forwarder supprime donc
`cf-*`, `x-forwarded-*`, `x-real-ip`, `cdn-loop` avant de joindre le
fournisseur — la requête apparaît comme venant directement de la maison.

## Défenses côté proxy edge (workers/mbolo-tv-video-proxy)

- Signature HMAC obligatoire des URL (voir docs/security/proxy-url-signature.md).
- Fallback « swap » borné (2 max/chaîne) : si un saut aboutit sur une IP brute
  refusée type Cloudflare 1003, on réessaie avec l'autorité du domaine précédent.
- Trace des sauts incluse dans le détail 502 (`detail.erreur`) pour diagnostic.
## Bypass direct (VOD)

Les URL de lecture VOD portent `&direct=1` (paramètre non signé, voir
`docs/security/proxy-url-signature.md`) : le proxy vidéo sort alors
directement des IP Cloudflare, **sans passer par le relais résidentiel** —
même pour les hôtes explicitement mappés dans `RELAY_MAP`. Motif : un film
mp4/mkv pèse plusieurs Go et génère des requêtes Range en rafale à chaque
seek ; la ligne résidentielle (~10 Mbps d'upload) ne doit porter que le live.
En cas d'échec total en direct (panel bloquant les IP datacenter), un seul
repli via le relais est tenté avant de renoncer.

Le VOD ne participe pas non plus à l'éco adaptatif : le compteur de chaînes
actives (heartbeats live) mesure la charge du relais, que le VOD n'utilise pas.
