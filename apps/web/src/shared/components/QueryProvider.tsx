'use client';

import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { del, get, set } from 'idb-keyval';
import { ReactNode, useState } from 'react';

// Référence partagée au client react-query : permet aux stores (ex. favoris)
// d'invalider des requêtes après une mutation, hors d'un composant React.
export let sharedQueryClient: QueryClient | null = null;

// Persistance IndexedDB du cache react-query : hors ligne, les dernières
// données connues (chaînes, films, favoris…) sont restaurées au démarrage
// au lieu d'un écran vide. On conserve 7 jours de données.
const queryPersister = createAsyncStoragePersister({
  storage: {
    getItem: async (key) => ((await get(key)) as string | undefined) ?? null,
    setItem: (key, value) => set(key, value).then(() => undefined),
    removeItem: (key) => del(key).then(() => undefined),
  },
});

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
  return (
    <PersistQueryClientProvider
      client={client}
      persistOptions={{
        persister: queryPersister,
        maxAge: 7 * 24 * 60 * 60 * 1000,
        // Ne persiste que les requêtes réussies : un échec réseau ne doit pas
        // écraser les données restaurées au démarrage suivant.
        dehydrateOptions: {
          shouldDehydrateQuery: (query) => query.state.status === 'success',
        },
      }}
    >
      {children}
    </PersistQueryClientProvider>
  );
}