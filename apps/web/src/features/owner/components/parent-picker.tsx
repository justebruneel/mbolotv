'use client';

import { useMemo, useState } from 'react';

export interface ParentPickerOption {
  id: string;
  name: string;
  parentId: string | null;
}

// Sélecteur de parent (déplacement dans l'arbre) : exclut le nœud lui-même et
// tout son sous-arbre — le backend refuserait de toute façon un cycle, mais
// n'afficher que des choix valides évite l'erreur. Partagé par le Catalogue
// public (catégories) et le Catalogue VOD (dossiers).
export function ParentPicker({ allFlat, childrenByParent, nodeId, currentParentId, onMove }: {
  allFlat: ParentPickerOption[];
  childrenByParent: Map<string | null, Array<{ id: string }>>;
  nodeId: string;
  currentParentId: string | null;
  onMove: (parentId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const exclude = useMemo(() => {
    const set = new Set<string>([nodeId]);
    const stack = [nodeId];
    while (stack.length) { const current = stack.pop() as string; for (const child of childrenByParent.get(current) ?? []) { set.add(child.id); stack.push(child.id); } }
    return set;
  }, [nodeId, childrenByParent]);
  const options = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allFlat.filter((category) => !exclude.has(category.id) && (!q || category.name.toLowerCase().includes(q))).slice(0, 20);
  }, [query, allFlat, exclude]);
  if (!open) return <button type="button" className="btn" onClick={() => setOpen(true)}>Déplacer…</button>;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        value={query}
        autoFocus
        placeholder="Dossier parent…"
        onChange={(event) => setQuery(event.target.value)}
        className="min-w-[180px] flex-1 rounded-lg border border-border bg-surface-2 px-3 py-1.5 text-sm"
      />
      <div className="flex max-h-40 w-full flex-wrap gap-1 overflow-y-auto">
        <button type="button" className="rounded-md bg-surface-2 px-2 py-1 text-xs font-medium hover:bg-surface-3" onClick={() => { onMove(null); setOpen(false); setQuery(''); }}>Racine</button>
        {options.map((option) => (
          <button key={option.id} type="button" className="rounded-md bg-surface-2 px-2 py-1 text-xs font-medium hover:bg-surface-3" onClick={() => { onMove(option.id); setOpen(false); setQuery(''); }}>{option.name}{option.id === currentParentId ? ' (actuel)' : ''}</button>
        ))}
      </div>
      <button type="button" className="btn" onClick={() => { setOpen(false); setQuery(''); }}>Annuler</button>
    </div>
  );
}
