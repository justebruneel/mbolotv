'use client';

import { useCategories } from '../../../shared/api/queries';
import { categoryLabel } from '../utils';
import { SearchIcon, XIcon } from './Icons';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

const DEBOUNCE_MS = 300;

// Recherche Netflix dans la barre de navigation : filtre le dossier courant
// (?category) ou tout le catalogue. L'état est piloté par l'URL (?q=) —
// l'écriture est gardée par un ref pour éviter tout écho replace ↔ searchParams.
export function HeaderSearch() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const category = searchParams.get('category') ?? undefined;
  const urlQuery = searchParams.get('q') ?? '';
  const [open, setOpen] = useState(Boolean(urlQuery));
  const [value, setValue] = useState(urlQuery);
  const lastWrittenRef = useRef<string | null>(urlQuery);

  const categoriesQuery = useCategories();
  const folderName = category ? categoryLabel(categoriesQuery.data ?? [], category) : undefined;

  function writeUrl(query: string): void {
    if (lastWrittenRef.current === query) return;
    lastWrittenRef.current = query;
    const params = new URLSearchParams(window.location.search);
    if (query) params.set('q', query);
    else params.delete('q');
    router.replace(params.toString() ? `/live?${params}` : '/live', { scroll: false });
  }

  // Debounce : écrit ?q une seule fois par frappe stabilisée.
  useEffect(() => {
    const query = value.trim();
    const timer = window.setTimeout(() => writeUrl(query), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [value]);

  function close(): void {
    setValue('');
    setOpen(false);
    writeUrl('');
  }

  if (!open) {
    return (
      <button
        type="button"
        aria-label="Rechercher"
        onClick={() => setOpen(true)}
        className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
      >
        <SearchIcon size={19} />
      </button>
    );
  }

  return (
    <div className="relative w-full" data-search-open={open ? "true" : undefined}>
      <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted">
        <SearchIcon size={16} />
      </span>
      <input
        type="search"
        autoFocus
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Escape') close(); }}
        placeholder={folderName ? `Rechercher dans « ${format(folderName)} »…` : 'Rechercher une chaîne…'}
        aria-label={folderName ? `Rechercher dans ${folderName}` : 'Rechercher une chaîne'}
        className="w-full rounded-xl border border-border bg-surface-2 py-2 pl-10 pr-9 text-sm font-medium placeholder:text-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
      />
      <button
        type="button"
        aria-label="Fermer la recherche"
        onClick={close}
        className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-full p-1 text-muted transition-colors hover:bg-surface-3 hover:text-foreground"
      >
        <XIcon size={13} />
      </button>
    </div>
  );
}

function format(name: string): string {
  return name.split('|').map((part) => part.trim()).filter(Boolean).slice(-1)[0] ?? name;
}
