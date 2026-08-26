'use client';

import { useCallback, useEffect, useState } from 'react';
import { ownerApi, type FeaturedChannelEntry } from '../api/owner-api';

interface ChannelHit { id: string; name: string; }

// « Mis en avant par pays » : la sélection d'un pays est servie aux visiteurs
// géolocalisés par Cloudflare sur la rangée « Chaînes locales » de /live.
export function FeaturedByCountryCard() {
  const [groups, setGroups] = useState<{ country: string; channels: FeaturedChannelEntry[] }[]>([]);
  const [country, setCountry] = useState('GA');
  const [chosen, setChosen] = useState<FeaturedChannelEntry[]>([]);
  const [search, setSearch] = useState('');
  const [hits, setHits] = useState<ChannelHit[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const loadGroups = useCallback(async (): Promise<void> => {
    try {
      const result = await ownerApi.featured.list();
      setGroups(result.items);
      return;
    } catch { /* silencieux : la carte reste fonctionnelle */ }
  }, []);

  useEffect(() => { void loadGroups(); }, [loadGroups]);

  // Charger la sélection existante du pays saisi.
  useEffect(() => {
    const code = country.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(code)) { setChosen([]); return; }
    let cancelled = false;
    void ownerApi.featured.list().then((result) => {
      if (cancelled) return;
      const group = result.items.find((item) => item.country.toUpperCase() === code);
      setChosen(group?.channels ?? []);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [country]);

  // Recherche de chaînes (débouncée).
  useEffect(() => {
    const query = search.trim();
    if (query.length < 2) { setHits([]); return; }
    const timer = window.setTimeout(async () => {
      try {
        const result = await ownerApi.catalogChannels({ q: query, limit: 20 });
        setHits(result.items.map((channel) => ({ id: channel.id, name: channel.name })));
      } catch { setHits([]); }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const save = async (): Promise<void> => {
    const code = country.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(code)) { setMessage('Code pays invalide (ex. GA).'); return; }
    setBusy(`save:${code}`); setMessage(null);
    try {
      const result = await ownerApi.featured.set(code, chosen.map((entry) => entry.id));
      setGroups(result.items);
      setMessage(`${chosen.length} chaîne(s) mises en avant pour ${code}.`);
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Enregistrement impossible.'); }
    finally { setBusy(null); }
  };

  const removeFromSaved = async (code: string, channelId: string): Promise<void> => {
    setBusy(`del:${channelId}`);
    try {
      const result = await ownerApi.featured.remove(code, channelId);
      setGroups(result.items);
      if (code === country.trim().toUpperCase()) setChosen(result.items.find((item) => item.country.toUpperCase() === code)?.channels ?? []);
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Suppression impossible.'); }
    finally { setBusy(null); }
  };

  const chosenIds = new Set(chosen.map((entry) => entry.id));

  return (
    <section className="card space-y-3 p-4">
      <div>
        <h2 className="font-semibold">Mis en avant par pays</h2>
        <p className="mt-1 text-xs text-muted">
          Ces chaînes composent la rangée « Chaînes locales », montrée aux visiteurs géolocalisés dans ce pays
          (détection IP via Cloudflare), avant toutes les autres suggestions.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <input
          value={country}
          onChange={(event) => setCountry(event.target.value.toUpperCase().slice(0, 2))}
          placeholder="Pays (GA)"
          aria-label="Code pays ISO"
          className="w-28 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm font-semibold uppercase"
        />
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Rechercher des chaînes à mettre en avant…"
          className="min-w-[220px] flex-1 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm font-semibold"
        />
        <button type="button" className="btn btn-primary" disabled={busy === `save:${country.trim().toUpperCase()}`} onClick={() => void save()}>
          {busy === `save:${country.trim().toUpperCase()}` ? 'Enregistrement…' : `Enregistrer (${chosen.length})`}
        </button>
      </div>

      {message && <p className="text-xs font-semibold text-accent">{message}</p>}

      {hits.filter((hit) => !chosenIds.has(hit.id)).length > 0 && (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
          {hits.filter((hit) => !chosenIds.has(hit.id)).map((hit) => (
            <li key={hit.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <span className="truncate">{hit.name}</span>
              <button
                type="button"
                className="btn shrink-0"
                onClick={() => setChosen((current) => [...current, { id: hit.id, name: hit.name, logoUrl: null }])}
              >
                + Ajouter
              </button>
            </li>
          ))}
        </ul>
      )}

      {chosen.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-widest text-muted">Sélection ({chosen.length})</p>
          <ul className="flex flex-wrap gap-2">
            {chosen.map((entry) => (
              <li key={entry.id} className="flex items-center gap-2 rounded-full border border-border bg-surface-2 py-1 pl-3 pr-1 text-xs font-semibold">
                <span className="max-w-[200px] truncate">{entry.name}</span>
                <button
                  type="button"
                  aria-label={`Retirer ${entry.name}`}
                  disabled={busy === `del:${entry.id}`}
                  onClick={() => setChosen((current) => current.filter((item) => item.id !== entry.id))}
                  className="rounded-full px-1.5 text-muted hover:text-danger"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {groups.length > 0 && (
        <div className="space-y-2 border-t border-border pt-3">
          <p className="text-xs font-semibold uppercase tracking-widest text-muted">Pays configurés</p>
          {groups.map((group) => (
            <div key={group.country} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="rounded-md bg-accent/15 px-2 py-0.5 text-xs font-black tracking-wide text-accent">{group.country}</span>
              {group.channels.map((entry) => (
                <span key={entry.id} className="flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs">
                  {entry.name}
                  <button
                    type="button"
                    aria-label={`Retirer ${entry.name} de ${group.country}`}
                    disabled={busy === `del:${entry.id}`}
                    onClick={() => void removeFromSaved(group.country, entry.id)}
                    className="text-muted hover:text-danger"
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
