'use client';

import { Button, Icon } from '@mbolo/ui';
import Link from 'next/link';
import { useFavoritesStore } from '../shared/stores/favorites';
import { useSettingsStore } from '../shared/stores/settings';

const SHORTCUTS = [
  { href: '/live', label: 'Live TV', description: 'Parcourir les chaînes en direct', icon: <Icon.Tv size={22} /> },
  { href: '/epg', label: 'Guide TV', description: 'Voir la programmation', icon: <Icon.CalendarDays size={22} /> },
  { href: '/matches', label: 'Matches', description: 'Les matchs à suivre', icon: <Icon.Trophy size={22} /> },
  { href: '/favorites', label: 'Favoris', description: 'Vos chaînes préférées', icon: <Icon.Heart size={22} /> },
];

export default function HomePage() {
  const lastWatched = useSettingsStore((state) => state.lastWatched);
  const clearLastWatched = useSettingsStore((state) => state.clearLastWatched);
  const favoritesCount = useFavoritesStore((state) => state.ids.length);
  const last = lastWatched[0];

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/40 bg-accent/10 px-3 py-1 text-xs font-semibold text-accent">
        <Icon.Radio size={13} />
        IPTV multi-sources
      </span>
      <h1 className="mt-4 text-3xl font-bold tracking-tight sm:text-4xl">
        Bienvenue sur <span className="text-accent">Mbolo TV</span>
      </h1>
      <p className="mt-2 max-w-xl text-muted">
        Regardez vos chaînes préférées en direct, où que vous soyez.
      </p>

      {last && (
        <section className="card mt-8 p-5">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-xs uppercase tracking-wider text-muted font-medium">Reprendre la lecture</p>
              <p className="mt-1 truncate text-lg font-semibold">{last.name}</p>
              <p className="text-sm text-muted">
                Regardée le{' '}
                {new Date(last.watchedAt).toLocaleString('fr-FR', {
                  day: '2-digit',
                  month: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </p>
            </div>
            <Link href={`/watch/${last.channelId}`} className="shrink-0">
              <Button variant="primary">
                <Icon.Play size={15} /> Regarder
              </Button>
            </Link>
          </div>
          {lastWatched.length > 1 && (
            <button
              type="button"
              onClick={clearLastWatched}
              className="mt-3 text-xs text-muted transition-colors hover:text-danger"
            >
              Effacer l'historique
            </button>
          )}
        </section>
      )}

      <div className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {SHORTCUTS.map((shortcut) => (
          <Link
            key={shortcut.href}
            href={shortcut.href}
            className="group flex items-center gap-4 rounded-xl border border-border bg-surface p-4 transition-colors hover:border-accent/60"
          >
            <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-surface-2 text-muted transition-colors group-hover:bg-accent/15 group-hover:text-accent">
              {shortcut.icon}
            </span>
            <span className="min-w-0">
              <span className="flex items-center font-semibold">
                {shortcut.label}
                {shortcut.href === '/favorites' && favoritesCount > 0 && (
                  <span className="ml-2 rounded-full bg-accent px-2 py-0.5 text-xs font-bold text-on-accent">
                    {favoritesCount}
                  </span>
                )}
              </span>
              <span className="block text-sm text-muted">{shortcut.description}</span>
            </span>
            <Icon.ChevronRight size={16} className="ml-auto shrink-0 text-muted transition-colors group-hover:text-accent" />
          </Link>
        ))}
      </div>
    </div>
  );
}