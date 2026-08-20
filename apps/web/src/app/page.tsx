'use client';

import { Button, Icon } from '@mbolo/ui';
import Link from 'next/link';
import { useFavoritesStore } from '../shared/stores/favorites';
import { useSettingsStore } from '../shared/stores/settings';

const SHORTCUTS = [
  { href: '/live', label: 'Live TV', description: 'Parcourir les chaînes en direct', icon: <Icon.Tv size={24} /> },
  { href: '/favorites', label: 'Favoris', description: 'Vos chaînes préférées', icon: <Icon.Heart size={24} /> },
];

export default function HomePage() {
  const lastWatched = useSettingsStore((state) => state.lastWatched);
  const clearLastWatched = useSettingsStore((state) => state.clearLastWatched);
  const favoritesCount = useFavoritesStore((state) => state.ids.length);
  const last = lastWatched[0];

  return (
    <div className="mx-auto max-w-4xl px-6 py-12 sm:py-16">
      {/* Hero */}
      <div className="animate-slide-up">
        <span className="inline-flex items-center gap-2 rounded-full border border-accent/30 bg-accent/10 px-4 py-1.5 text-xs font-bold tracking-wide text-accent backdrop-blur-sm">
          <Icon.Radio size={14} />
          IPTV MULTI-SOURCES
        </span>
      </div>

      <h1 className="mt-6 text-4xl font-extrabold tracking-tight sm:text-5xl lg:text-6xl animate-slide-up stagger-1">
        Regardez le direct,
        <br />
        <span className="bg-gradient-to-r from-accent via-accent-hover to-accent bg-clip-text text-transparent">
          sans limites.
        </span>
      </h1>

      <p className="mt-4 max-w-xl text-lg leading-relaxed text-secondary animate-slide-up stagger-2">
        Vos chaînes préférées en streaming adaptatif, disponible partout sur tous vos appareils.
      </p>

      <div className="mt-8 flex flex-wrap gap-3 animate-slide-up stagger-3">
        <Link href="/live">
          <Button variant="primary" className="!px-6 !py-3 !text-base !rounded-xl">
            <Icon.Play size={18} /> Commencer à regarder
          </Button>
        </Link>
        {favoritesCount > 0 && (
          <Link href="/favorites">
            <Button className="!px-6 !py-3 !text-base !rounded-xl">
              <Icon.Heart size={18} /> {favoritesCount} favori{favoritesCount > 1 ? 's' : ''}
            </Button>
          </Link>
        )}
      </div>

      {/* Resume watching */}
      {last && (
        <section className="mt-12 animate-scale-in stagger-4">
          <p className="mb-3 text-xs font-bold uppercase tracking-widest text-muted">
            Reprendre la lecture
          </p>
          <div className="group relative overflow-hidden rounded-2xl border border-border bg-gradient-to-br from-surface via-surface to-surface-2 p-6 transition-all duration-300 hover:border-accent/50 hover:shadow-lg">
            <div className="absolute inset-0 bg-gradient-to-r from-accent/5 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
            <div className="relative flex items-center justify-between gap-6">
              <div className="min-w-0">
                <p className="text-2xl font-bold tracking-tight">{last.name}</p>
                <p className="mt-1 text-sm text-muted">
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
                <Button variant="primary" className="!px-5 !py-2.5">
                  <Icon.Play size={16} /> Regarder
                </Button>
              </Link>
            </div>
            {lastWatched.length > 1 && (
              <button
                type="button"
                onClick={clearLastWatched}
                className="relative mt-4 text-xs text-muted transition-colors hover:text-danger"
              >
                Effacer l'historique
              </button>
            )}
          </div>
        </section>
      )}

      {/* Quick access */}
      <div className="mt-12 grid grid-cols-1 gap-4 sm:grid-cols-2">
        {SHORTCUTS.map((shortcut, i) => (
          <Link
            key={shortcut.href}
            href={shortcut.href}
            className={`group relative flex items-center gap-5 rounded-2xl border border-border bg-surface p-5 transition-all duration-300 hover:border-accent/50 hover:shadow-md hover:-translate-y-0.5 animate-scale-in stagger-${4 + i}`}
          >
            <span className="flex h-14 w-14 items-center justify-center rounded-xl bg-surface-2 text-muted transition-all duration-300 group-hover:bg-accent/15 group-hover:text-accent group-hover:scale-110 group-hover:shadow-glow">
              {shortcut.icon}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center text-lg font-bold">
                {shortcut.label}
                {shortcut.href === '/favorites' && favoritesCount > 0 && (
                  <span className="ml-2.5 rounded-full bg-accent px-2.5 py-0.5 text-xs font-bold text-on-accent">
                    {favoritesCount}
                  </span>
                )}
              </span>
              <span className="block mt-0.5 text-sm text-muted">{shortcut.description}</span>
            </span>
            <Icon.ChevronRight
              size={18}
              className="shrink-0 text-muted transition-all duration-300 group-hover:text-accent group-hover:translate-x-1"
            />
          </Link>
        ))}
      </div>

      {/* Footer tagline */}
      <p className="mt-16 text-center text-xs text-faint animate-fade-in stagger-6">
        Streaming adaptatif · Multi-sources · PWA installable
      </p>
    </div>
  );
}
