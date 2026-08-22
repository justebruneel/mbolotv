#!/usr/bin/env bash
# Setup auto-hébergé Mbolo TV sur Fedora (essai, sans carte)
# Lance avec : sudo bash scripts/setup-fedora.sh
set -euo pipefail
REPO="/home/bruneel/Bureau/mbolo TV"
cd "$REPO"

echo "== Installation de Docker (méthode officielle, inclut le plugin compose v2) =="
sudo dnf install -y curl >/dev/null 2>&1 || true
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sudo sh
fi
sudo systemctl enable --now docker

echo "== Build de l'image (api + worker) =="
sudo docker compose build

echo "== Démarrage du stack (redis + api + worker) =="
sudo docker compose up -d

echo "== Attente de la santé de l'API (/api/health) =="
OK=0
for i in $(seq 1 24); do
  if sudo docker compose exec -T api node -e "fetch('http://localhost:4000/api/health').then(r=>{if(!r.ok)process.exit(1);console.log('API OK');process.exit(0)}).catch(()=>process.exit(1))" 2>/dev/null; then
    OK=1
    break
  fi
  echo "  en attente de l'API... ($i)"
  sleep 5
done

echo "== Statut des conteneurs =="
sudo docker compose ps

if [ "$OK" -eq 1 ]; then
  echo ""
  echo "Backend démarré sur http://localhost:4000"
  echo "Prochaines étapes :"
  echo "  1) Installer playit.gg et exposer le port 4000 (URL publique)."
  echo "  2) Mettre à jour PUBLIC_API_URL dans docker.env avec l'URL playit, puis 'sudo docker compose up -d api'."
  echo "  3) Dans Vercel : définir NEXT_PUBLIC_API_URL et API_URL = <url playit>, puis redéployer."
else
  echo ""
  echo "L'API n'a pas répondu au healthcheck. Consultez les logs : sudo docker compose logs api"
fi
