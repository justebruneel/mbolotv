import type { NextConfig } from 'next';

// URL de l'API vue du serveur (middleware + proxy de la console owner).
// En production (Vercel) : renseigner API_URL dans les variables d'environnement.
const apiUrl = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

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
