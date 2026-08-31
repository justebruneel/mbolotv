import type { NextConfig } from 'next';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// URL de l'API vue du serveur (middleware + proxy de la console owner).
// En production (Vercel) : renseigner API_URL dans les variables d'environnement.
const apiUrl = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

// Le service worker est généré au build depuis sw.template.js avec une version
// unique : son contenu change à chaque déploiement, le navigateur le
// réinstalle et purge les caches runtime périmés. En cas de système de
// fichiers en lecture seule (démarrage Vercel), le sw.js déjà généré au build
// fait l'affaire — l'écriture est ignorée.
if (process.env.NODE_ENV === 'production') {
  try {
    const templatePath = resolve('public/sw.template.js');
    if (existsSync(templatePath)) {
      const template = readFileSync(templatePath, 'utf8');
      const versioned = template.replace(
        /const VERSION = '[^']*';/,
        `const VERSION = 'build-${Date.now().toString(36)}';`,
      );
      if (versioned !== template) writeFileSync(resolve('public/sw.js'), versioned);
    }
  } catch {
    /* lecture seule : ignoré */
  }
}

const nextConfig: NextConfig = {
  transpilePackages: ['@mbolo/ui'],
  async rewrites() {
    return [
      // La console owner passe par le même site que le web : le cookie de session
      // est posé sur le domaine du web (aucun blocage de cookie tiers).
      { source: '/api/owner/:path*', destination: `${apiUrl}/api/owner/:path*` },
    ];
  },
};

export default nextConfig;
