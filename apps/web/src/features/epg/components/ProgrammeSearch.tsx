'use client';

import { EmptyState, Icon, Spinner } from '@mbolo/ui';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useProgrammeSearch } from '../../../shared/api/queries';
import { RemindButton } from './RemindButton';

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

export function ProgrammeSearch() {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const searchQuery = useProgrammeSearch(debounced);

  return (
    <section>
      <div className="relative">
        <Icon.Search
          size={16}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-muted"
        />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Rechercher un programme (match, film, émission...)"
          className="w-full rounded-lg bg-surface-2 border border-border pl-9 pr-3 py-2.5 text-sm text-foreground placeholder:text-muted focus:outline-none focus:border-accent/60"
        />
      </div>

      {debounced.length >= 2 && (
        <div className="mt-4">
          {searchQuery.isLoading && (
            <div className="flex justify-center p-6">
              <Spinner />
            </div>
          )}

          {searchQuery.isError && (
            <p className="text-sm text-muted">Recherche indisponible pour le moment.</p>
          )}

          {!searchQuery.isLoading && !searchQuery.isError && searchQuery.data?.items.length === 0 && (
            <EmptyState title="Aucun résultat" hint="Essayez d'autres mots-clés." />
          )}

          {searchQuery.data && searchQuery.data.items.length > 0 && (
            <ul className="space-y-2">
              {searchQuery.data.items.map((item) => (
                <li
                  key={item.id}
                  className="flex items-center gap-3 rounded-lg bg-surface-2/60 border border-border/60 px-3 py-2.5"
                >
                  <span className="shrink-0 w-14 text-right text-xs text-muted tabular-nums">
                    {formatTime(item.startsAt)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground truncate">{item.title}</p>
                    <button
                      type="button"
                      onClick={() => router.push(`/watch/${item.channelId}`)}
                      className="text-xs text-muted hover:text-accent transition-colors truncate"
                    >
                      {item.channel.name}
                    </button>
                  </div>
                  <RemindButton
                    programme={{
                      id: item.id,
                      channelId: item.channelId,
                      channelName: item.channel.name,
                      title: item.title,
                      startsAt: item.startsAt,
                    }}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
