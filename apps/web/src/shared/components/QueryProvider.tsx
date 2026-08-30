'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactNode, useState } from 'react';

// Référence partagée au client react-query : permet aux stores (ex. favoris)
// d'invalider des requêtes après une mutation, hors d'un composant React.
export let sharedQueryClient: QueryClient | null = null;

export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false },
        },
      }),
  );
  sharedQueryClient = client;
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
