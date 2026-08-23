#!/usr/bin/env bash
# Installe cloudflared en service systemd sur l'hôte (plan B anti-docker NAT).
# Usage : sudo bash scripts/install-cloudflared-host.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CF_DIR="$ROOT/cloudflared-data"
BIN=/usr/local/bin/cloudflared

if [ "$(id -u)" -ne 0 ]; then echo "À exécuter avec sudo." >&2; exit 1; fi

# 1. Binaire (téléchargé seulement si absent)
if [ ! -x "$BIN" ] && [ ! -x /tmp/opencode/cloudflared ]; then
  echo "Téléchargement de cloudflared…"
  curl -sL -o /tmp/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
  install -m 755 /tmp/cloudflared "$BIN"
elif [ -x /tmp/opencode/cloudflared ] && [ ! -x "$BIN" ]; then
  install -m 755 /tmp/opencode/cloudflared "$BIN"
fi

# 2. Configuration + secrets du tunnel
mkdir -p /etc/cloudflared
install -m 600 "$CF_DIR"/2d4b4742-0703-4f6f-a801-693be15a3131.json /etc/cloudflared/
install -m 644 "$CF_DIR/config-host.yml" /etc/cloudflared/

# 3. Service systemd
install -m 644 "$ROOT/infra/systemd/cloudflared-mbolo.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now cloudflared-mbolo.service

# 4. Retire l'ancien conteneur docker s'il tourne encore
docker rm -f mbolotv-cloudflared-1 2>/dev/null || true

echo "Service installé. Vérification :"
sleep 8
systemctl --no-pager -l status cloudflared-mbolo.service | head -12 || true
