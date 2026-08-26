'use client';

import type { OwnerCatalog, OwnerCategory, OwnerChannel } from '@mbolo/contracts';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ownerApi } from '../../../../../features/owner/api/owner-api';
import { FeaturedByCountryCard } from '../../../../../features/owner/components/featured-by-country';

type Tests = Record<string, string>;

type OrderInfo = { siblings: OwnerCategory[]; index: number };

type ChannelPage = { items: OwnerChannel[]; total: number };

// Les canaux ne voyagent plus dans l'arbre du catalogue (53k chaînes = 12 Mo
// de JSON et un DOM qui fige l'onglet). Chaque dossier ouvert charge ses
// chaînes serveur, 50 à la fois.
const PAGE_SIZE = 50;
const AUTO_OPEN_MAX_CHANNELS = 100;

function pageKey(categoryId: string | null): string {
  return categoryId ?? 'none';
}

function flattenCategories(nodes: OwnerCategory[], acc: OwnerCategory[] = []): OwnerCategory[] {
  for (const node of nodes) { acc.push(node); flattenCategories(node.children ?? [], acc); }
  return acc;
}

function buildOrderMap(nodes: OwnerCategory[]): Map<string, OrderInfo> {
  const map = new Map<string, OrderInfo>();
  const walk = (list: OwnerCategory[]): void => {
    list.forEach((node, index) => { map.set(node.id, { siblings: list, index }); walk(node.children ?? []); });
  };
  walk(nodes);
  return map;
}

function buildChildrenByParent(nodes: OwnerCategory[]): Map<string | null, OwnerCategory[]> {
  const map = new Map<string | null, OwnerCategory[]>();
  const walk = (list: OwnerCategory[]): void => {
    for (const node of list) {
      const bucket = map.get(node.parentId) ?? [];
      bucket.push(node);
      map.set(node.parentId, bucket);
      walk(node.children ?? []);
    }
  };
  walk(nodes);
  return map;
}

const ChannelRow = memo(function ChannelRow({ channel, onToggle, onTest, tests, busy, selectable, selected, onSelect }: { channel: OwnerChannel; onToggle: (id: string, visible: boolean) => void; onTest: (id: string) => void; tests: Tests; busy: string | null; selectable?: boolean; selected?: boolean; onSelect?: (id: string) => void }) {
  const test = tests[channel.id];
  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3">
      {selectable && (
        <input
          type="checkbox"
          aria-label={`Sélectionner ${channel.name}`}
          checked={Boolean(selected)}
          onChange={() => onSelect?.(channel.id)}
        />
      )}
      <div className="min-w-[200px] flex-1">
        <p className="text-sm font-medium">{channel.name}</p>
        <p className="text-xs text-muted">{channel.variantsCount} source(s) · {channel.healthStatus ?? 'non testé'}</p>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={channel.isVisible} disabled={busy === channel.id} onChange={(event) => onToggle(channel.id, event.target.checked)} /> Publié
      </label>
      <button className="btn" disabled={busy === `test:${channel.id}`} onClick={() => onTest(channel.id)}>{busy === `test:${channel.id}` ? 'Test…' : 'Tester'}</button>
      {test && <span className={`text-xs font-semibold ${test === 'OK' ? 'text-success' : 'text-danger'}`}>{test}</span>}
    </div>
  );
});

function ChannelList({ page, onToggle, onTest, tests, busy, onLoadMore, selectable, selectedIds, onSelect }: { page: ChannelPage; onToggle: (id: string, visible: boolean) => void; onTest: (id: string) => void; tests: Tests; busy: string | null; onLoadMore?: () => void; selectable?: boolean; selectedIds?: Set<string>; onSelect?: (id: string) => void }) {
  return (
    <div className="divide-y divide-border/70">
      {page.items.map((channel) => (
        <ChannelRow key={channel.id} channel={channel} onToggle={onToggle} onTest={onTest} tests={tests} busy={busy} selectable={selectable} selected={selectedIds?.has(channel.id)} onSelect={onSelect} />
      ))}
      {onLoadMore && page.items.length < page.total && (
        <div className="bg-surface-2/40 p-3 text-center">
          <button type="button" className="btn" onClick={onLoadMore}>Afficher plus ({page.items.length}/{page.total})</button>
        </div>
      )}
    </div>
  );
}

function ParentPicker({ allFlat, childrenByParent, nodeId, currentParentId, onMove }: { allFlat: OwnerCategory[]; childrenByParent: Map<string | null, OwnerCategory[]>; nodeId: string; currentParentId: string | null; onMove: (parentId: string | null) => void }) {
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

function CategoryNode({ node, depth, onUpdate, onCreateSub, onDelete, onToggleChannel, onTest, onReorder, onMoveParent, tests, busy, orderMap, allFlat, childrenByParent, getChannels, isChannelsLoading, ensureChannels, loadMoreChannels }: {
  node: OwnerCategory;
  depth: number;
  onUpdate: (id: string, patch: { name?: string; isVisible?: boolean }) => void;
  onCreateSub: (parentId: string, name: string) => void;
  onDelete: (id: string) => void;
  onToggleChannel: (id: string, visible: boolean) => void;
  onTest: (id: string) => void;
  onReorder: (id: string, sortOrder: number) => void;
  onMoveParent: (id: string, parentId: string | null) => void;
  tests: Tests;
  busy: string | null;
  orderMap: Map<string, OrderInfo>;
  allFlat: OwnerCategory[];
  childrenByParent: Map<string | null, OwnerCategory[]>;
  getChannels: (categoryId: string) => ChannelPage | undefined;
  isChannelsLoading: (categoryId: string) => boolean;
  ensureChannels: (categoryId: string) => void;
  loadMoreChannels: (categoryId: string) => void;
}) {
  // Les gros dossiers restent fermés par défaut pour éviter de déclencher
  // des dizaines de chargements au premier rendu.
  const [open, setOpen] = useState(depth === 0 && node.channelCount <= AUTO_OPEN_MAX_CHANNELS);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(node.name);
  const [subName, setSubName] = useState('');
  const childCount = (node.children ?? []).length;
  const dimmed = !node.effectiveVisible;
  const order = orderMap.get(node.id);
  const canUp = order ? order.index > 0 : false;
  const canDown = order ? order.index < order.siblings.length - 1 : false;

  useEffect(() => { if (open) ensureChannels(node.id); }, [open, ensureChannels, node.id]);
  const channels = getChannels(node.id);
  const channelsLoading = isChannelsLoading(node.id);

  return (
    <section className="card overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-border p-4" style={{ paddingLeft: `${16 + depth * 14}px` }}>
        <button type="button" onClick={() => setOpen((value) => !value)} aria-label={open ? 'Réduire' : 'Déployer'} className="shrink-0 rounded-md px-1 py-1 text-muted hover:bg-surface-3 hover:text-foreground">{open ? '▾' : '▸'}</button>
        {editing ? (
          <input
            value={name}
            autoFocus
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && name.trim()) { onUpdate(node.id, { name: name.trim() }); setEditing(false); } if (event.key === 'Escape') { setName(node.name); setEditing(false); } }}
            className="min-w-[200px] flex-1 rounded-lg border border-border bg-surface-2 px-3 py-1.5 text-sm font-semibold"
          />
        ) : (
          <button type="button" onClick={() => setEditing(true)} className={`flex-1 truncate text-left text-sm font-semibold ${dimmed ? 'text-muted line-through' : ''}`}>{node.name}</button>
        )}
        <span className="text-xs text-muted">{node.channelCount} chaîne{node.channelCount > 1 ? 's' : ''}{childCount > 0 ? ` · ${childCount} sous-dossier${childCount > 1 ? 's' : ''}` : ''}</span>
        <button type="button" className="btn" disabled={!canUp || busy === node.id} onClick={() => order && onReorder(node.id, order.index - 1)} aria-label="Monter">↑</button>
        <button type="button" className="btn" disabled={!canDown || busy === node.id} onClick={() => order && onReorder(node.id, order.index + 1)} aria-label="Descendre">↓</button>
        <label className="flex items-center gap-2 text-sm" title={dimmed ? 'Masqué (un dossier parent est masqué)' : 'Visible'}>
          <input type="checkbox" checked={node.isVisible} onChange={(event) => onUpdate(node.id, { isVisible: event.target.checked })} /> Publié
        </label>
        <button type="button" className="btn btn-danger" onClick={() => setEditing(true)}>Renommer</button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={busy === node.id}
          onClick={() => {
            if (window.confirm(`Supprimer le dossier « ${node.name} » ?\n\nLes chaînes passent en « Sans dossier » et les sous-dossiers remontent d'un niveau. Aucune chaîne n'est supprimée.`)) onDelete(node.id);
          }}
        >
          Supprimer
        </button>
        <ParentPicker allFlat={allFlat} childrenByParent={childrenByParent} nodeId={node.id} currentParentId={node.parentId} onMove={(parentId) => onMoveParent(node.id, parentId)} />
      </div>

      {open && (
        <div className="divide-y divide-border/70">
          {channels ? (
            <ChannelList page={channels} onToggle={onToggleChannel} onTest={onTest} tests={tests} busy={busy} onLoadMore={channels.items.length < channels.total ? () => loadMoreChannels(node.id) : undefined} />
          ) : (
            <div className="p-3 text-sm text-muted">{channelsLoading ? 'Chargement des chaînes…' : 'Aucune chaîne dans ce dossier.'}</div>
          )}

          <div className="flex flex-wrap items-center gap-2 bg-surface-2/40 p-3">
            <input
              value={subName}
              placeholder="Nouveau sous-dossier…"
              onChange={(event) => setSubName(event.target.value)}
              className="min-w-[200px] flex-1 rounded-lg border border-border bg-surface-2 px-3 py-1.5 text-sm"
            />
            <button
              type="button"
              className="btn btn-primary"
              disabled={!subName.trim()}
              onClick={() => { if (subName.trim()) { onCreateSub(node.id, subName.trim()); setSubName(''); } }}
            >
              + Sous-dossier
            </button>
          </div>

          {(node.children ?? []).map((child) => (
            <CategoryNode key={child.id} node={child} depth={depth + 1} onUpdate={onUpdate} onCreateSub={onCreateSub} onDelete={onDelete} onToggleChannel={onToggleChannel} onTest={onTest} onReorder={onReorder} onMoveParent={onMoveParent} tests={tests} busy={busy} orderMap={orderMap} allFlat={allFlat} childrenByParent={childrenByParent} getChannels={getChannels} isChannelsLoading={isChannelsLoading} ensureChannels={ensureChannels} loadMoreChannels={loadMoreChannels} />
          ))}
        </div>
      )}
    </section>
  );
}

export default function CatalogControlPage() {
  const [catalog, setCatalog] = useState<OwnerCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rootName, setRootName] = useState('');
  const [tests, setTests] = useState<Tests>({});
  const [pages, setPages] = useState<Record<string, ChannelPage>>({});
  const [loadingPages, setLoadingPages] = useState<Record<string, boolean>>({});
  const loadedRef = useRef<Set<string>>(new Set());
  const pagesRef = useRef<Record<string, ChannelPage>>({});
  pagesRef.current = pages;
  const loadingPagesRef = useRef<Record<string, boolean>>({});
  loadingPagesRef.current = loadingPages;
  const [searchQuery, setSearchQuery] = useState('');
  const [searchPage, setSearchPage] = useState<ChannelPage | null>(null);
  const searchPageRef = useRef<ChannelPage | null>(null);
  searchPageRef.current = searchPage;
  const [uncategorizedOpen, setUncategorizedOpen] = useState(false);
  // Mode sélection multiple : liste plate triée par nom + suppression en lot.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectFilter, setSelectFilter] = useState('');
  const [deletingBatch, setDeletingBatch] = useState(false);
  // Suppression des chaînes « sans dossier ».
  const [uncatSelectMode, setUncatSelectMode] = useState(false);
  const [uncatSelected, setUncatSelected] = useState<Set<string>>(new Set());
  const [deletingChannels, setDeletingChannels] = useState(false);

  const orderMap = useMemo(() => (catalog ? buildOrderMap(catalog.categories) : new Map<string, OrderInfo>()), [catalog]);
  const allFlat = useMemo(() => (catalog ? flattenCategories(catalog.categories) : []), [catalog]);
  const childrenByParent = useMemo(() => (catalog ? buildChildrenByParent(catalog.categories) : new Map<string | null, OwnerCategory[]>()), [catalog]);

  useEffect(() => { void reload(); }, []);

  // Recherche globale côté serveur, débouncée.
  useEffect(() => {
    const query = searchQuery.trim();
    if (query.length < 2) { setSearchPage(null); return; }
    const timer = window.setTimeout(async () => {
      try { setSearchPage(await ownerApi.catalogChannels({ q: query, limit: PAGE_SIZE })); }
      catch (reason) { setError(reason instanceof Error ? reason.message : 'Recherche impossible.'); }
    }, 350);
    return () => window.clearTimeout(timer);
  }, [searchQuery]);

  const fetchPage = useCallback(async (categoryId: string | null, mode: 'replace' | 'append'): Promise<void> => {
    const key = pageKey(categoryId);
    setLoadingPages((current) => ({ ...current, [key]: true }));
    try {
      const offset = mode === 'append' ? pagesRef.current[key]?.items.length ?? 0 : 0;
      const data = await ownerApi.catalogChannels({ categoryId, limit: PAGE_SIZE, offset });
      setPages((current) => {
        const previous = mode === 'append' ? current[key] : undefined;
        const merged: ChannelPage = previous ? { items: [...previous.items, ...data.items], total: data.total } : data;
        return { ...current, [key]: merged };
      });
    } catch (reason) {
      loadedRef.current.delete(key);
      setError(reason instanceof Error ? reason.message : 'Chargement des chaînes impossible.');
    } finally {
      setLoadingPages((current) => { const next = { ...current }; delete next[key]; return next; });
    }
  }, []);

  const ensureChannels = useCallback((categoryId: string) => {
    const key = pageKey(categoryId);
    if (loadedRef.current.has(key)) return;
    loadedRef.current.add(key);
    void fetchPage(categoryId, 'replace');
  }, [fetchPage]);

  const loadMoreChannels = useCallback((categoryId: string) => { void fetchPage(categoryId, 'append'); }, [fetchPage]);

  const getChannels = useCallback((categoryId: string) => pagesRef.current[pageKey(categoryId)], []);
  const isChannelsLoading = useCallback((categoryId: string) => Boolean(loadingPagesRef.current[pageKey(categoryId)]), []);

  const loadMoreSearch = useCallback(() => {
    const current = searchPageRef.current;
    if (!current || current.items.length >= current.total) return;
    const query = searchQuery.trim();
    void ownerApi.catalogChannels({ q: query, limit: PAGE_SIZE, offset: current.items.length })
      .then((data) => setSearchPage({ items: [...current.items, ...data.items], total: data.total }))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Recherche impossible.'));
  }, [searchQuery]);

  async function reload(): Promise<void> {
    try { setCatalog(await ownerApi.catalog()); setError(null); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Connexion propriétaire requise.'); }
  }
  async function updateCategory(id: string, patch: { name?: string; isVisible?: boolean; sortOrder?: number; parentId?: string | null }): Promise<void> {
    setBusy(id); try { setCatalog(await ownerApi.categories.update(id, patch)); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Modification impossible.'); } finally { setBusy(null); }
  }
  async function createFolder(parentId: string | null, name: string): Promise<void> {
    const key = parentId ?? 'root';
    setBusy(`create:${key}`); try { setCatalog(await ownerApi.categories.create({ name, parentId })); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Création impossible.'); } finally { setBusy(null); }
  }
  async function deleteCategory(id: string): Promise<void> {
    setBusy(id); try { setCatalog(await ownerApi.categories.remove(id)); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Suppression impossible.'); } finally { setBusy(null); }
  }
  const selectableList = useMemo(
    () => [...allFlat].sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' })),
    [allFlat],
  );
  const parentNameById = useMemo(() => new Map(allFlat.map((node) => [node.id, node.name])), [allFlat]);
  const filteredSelectable = useMemo(() => {
    const query = selectFilter.trim().toLowerCase();
    if (!query) return selectableList;
    return selectableList.filter((node) => node.name.toLowerCase().includes(query));
  }, [selectableList, selectFilter]);

  function toggleSelected(id: string): void {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function deleteSelected(): Promise<void> {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    if (!window.confirm(`Supprimer ${ids.length} dossier(s) ?\n\nLes chaînes passent en « Sans dossier » et les sous-dossiers remontent d'un niveau. Aucune chaîne n'est supprimée.`)) return;
    setDeletingBatch(true);
    try {
      setCatalog(await ownerApi.categories.removeBatch(ids));
      setSelectedIds(new Set());
      setSelectMode(false);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Suppression impossible.');
    } finally {
      setDeletingBatch(false);
    }
  }
  function toggleUncatSelected(id: string): void {
    setUncatSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  // « Tout cocher » sélectionne TOUTES les chaînes sans dossier côté serveur,
  // pas seulement les 50 lignes chargées à l'écran.
  const [checkingAllUncat, setCheckingAllUncat] = useState(false);
  async function checkAllUncategorized(): Promise<void> {
    setCheckingAllUncat(true);
    try {
      const { ids } = await ownerApi.channels.ids('uncategorized');
      setUncatSelected(new Set(ids));
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Sélection complète impossible.');
    } finally {
      setCheckingAllUncat(false);
    }
  }
  async function deleteUncatSelected(): Promise<void> {
    const ids = [...uncatSelected];
    if (ids.length === 0) return;
    if (!window.confirm(`Supprimer définitivement ${ids.length} chaîne(s) sans dossier ?\n\nCette action est irréversible (flux, EPG et favoris associés sont supprimés). Un nouvel import peut les recréer.`)) return;
    setDeletingChannels(true);
    try {
      await ownerApi.channels.removeBatch(ids);
      setUncatSelected(new Set());
      setUncatSelectMode(false);
      setError(null);
      await reload();
      await fetchPage(null, 'replace');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Suppression impossible.');
    } finally {
      setDeletingChannels(false);
    }
  }
  async function updateChannel(id: string, isVisible: boolean): Promise<void> {
    // Patch optimiste local : le serveur ne renvoie plus les listes de chaînes.
    const apply = (items: OwnerChannel[]): OwnerChannel[] => items.map((channel) => (channel.id === id ? { ...channel, isVisible } : channel));
    setPages((current) => {
      const next: Record<string, ChannelPage> = {};
      for (const [key, page] of Object.entries(current)) next[key] = { ...page, items: apply(page.items) };
      return next;
    });
    setSearchPage((current) => (current ? { ...current, items: apply(current.items) } : current));
    setBusy(id);
    try { await ownerApi.channels.update(id, { isVisible }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Modification impossible.'); }
    finally { setBusy(null); }
  }
  const testChannel = useCallback(async (id: string): Promise<void> => {
    setBusy(`test:${id}`); setTests((current) => ({ ...current, [id]: 'test…' }));
    try { const result = await ownerApi.channels.test(id); setTests((current) => ({ ...current, [id]: result.ok ? 'OK' : 'Hors ligne' })); }
    catch (reason) { setTests((current) => ({ ...current, [id]: reason instanceof Error ? reason.message : 'Test impossible' })); }
    finally { setBusy(null); }
  }, []);

  if (error && !catalog) return <main className="p-6"><div className="card p-6 text-sm text-danger">{error}. <a className="font-semibold text-accent hover:underline" href="/owner/login">Se connecter</a></div></main>;
  if (!catalog) return <main className="p-6 text-sm text-muted">Chargement du catalogue…</main>;

  return (
    <main className="space-y-6 p-6">
      <header>
        <p className="text-xs font-semibold uppercase tracking-widest text-accent">Publication</p>
        <h1 className="mt-2 text-2xl font-bold">Catalogue public</h1>
        <p className="mt-1 text-sm text-muted">Renommez les dossiers, réorganisez-les (↑/↓), déplacez-les dans un autre dossier, masquez ce qui ne doit pas sortir et testez les chaînes avant publication. Un dossier masqué masque aussi ses sous-dossiers et ses chaînes.</p>
      </header>

      <FeaturedByCountryCard />

      {error && <p className="card border-danger/30 bg-danger-muted p-3 text-sm text-danger">{error}</p>}

      <section className="card flex flex-wrap items-center gap-3 p-4">
        <input
          value={searchQuery}
          placeholder="Rechercher une chaîne…"
          onChange={(event) => setSearchQuery(event.target.value)}
          className="min-w-[220px] flex-1 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm font-semibold"
        />
      </section>

      {searchPage && (
        <section className="card overflow-hidden">
          <div className="border-b border-border p-4 font-semibold">Résultats ({searchPage.total})</div>
          <ChannelList page={searchPage} onToggle={updateChannel} onTest={testChannel} tests={tests} busy={busy} onLoadMore={searchPage.items.length < searchPage.total ? loadMoreSearch : undefined} />
        </section>
      )}

      <section className="card flex flex-wrap items-center gap-3 p-4">
        <input
          value={rootName}
          placeholder="Nouveau dossier racine…"
          onChange={(event) => setRootName(event.target.value)}
          className="min-w-[220px] flex-1 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm font-semibold"
        />
        <button className="btn btn-primary" disabled={!rootName.trim() || busy === 'create:root'} onClick={() => { if (rootName.trim()) { void createFolder(null, rootName.trim()); setRootName(''); } }}>{busy === 'create:root' ? 'Création…' : 'Créer un dossier'}</button>
        <button
          type="button"
          className={`btn ${selectMode ? 'btn-danger' : ''}`}
          onClick={() => { setSelectMode((value) => !value); setSelectedIds(new Set()); setSelectFilter(''); }}
        >
          {selectMode ? 'Quitter la sélection' : 'Sélectionner'}
        </button>
      </section>

      {selectMode && (
        <section className="card overflow-hidden">
          <div className="flex flex-wrap items-center gap-3 border-b border-border p-4">
            <div className="flex-1">
              <p className="font-semibold">Suppression de dossiers</p>
              <p className="text-xs text-muted">Cochez les dossiers à supprimer. Les chaînes passeront en « Sans dossier » ; les sous-dossiers remontent d'un niveau.</p>
            </div>
            <input
              value={selectFilter}
              placeholder="Filtrer par nom…"
              onChange={(event) => setSelectFilter(event.target.value)}
              className="min-w-[180px] rounded-lg border border-border bg-surface-2 px-3 py-1.5 text-sm"
            />
            <button type="button" className="btn" onClick={() => setSelectedIds(new Set(filteredSelectable.map((node) => node.id)))}>Tout cocher ({filteredSelectable.length})</button>
            <button type="button" className="btn" onClick={() => setSelectedIds(new Set())}>Décocher</button>
          </div>
          <div className="max-h-[60vh] divide-y divide-border/70 overflow-y-auto">
            {filteredSelectable.map((node) => (
              <label key={node.id} className="flex cursor-pointer items-center gap-3 px-4 py-2 text-sm hover:bg-surface-2/60">
                <input
                  type="checkbox"
                  checked={selectedIds.has(node.id)}
                  onChange={() => toggleSelected(node.id)}
                />
                <span className="min-w-0 flex-1 truncate">{node.name}</span>
                {node.parentId && parentNameById.get(node.parentId) && (
                  <span className="shrink-0 text-xs text-muted">dans « {parentNameById.get(node.parentId)} »</span>
                )}
                <span className="shrink-0 font-mono text-xs text-muted">{node.channelCount} chaîne(s)</span>
              </label>
            ))}
            {filteredSelectable.length === 0 && <div className="p-4 text-sm text-muted">Aucun dossier ne correspond au filtre.</div>}
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-border bg-surface-2/40 p-4">
            <span className="text-sm text-muted">{selectedIds.size} dossier(s) sélectionné(s)</span>
            <button
              type="button"
              className="btn btn-danger"
              disabled={selectedIds.size === 0 || deletingBatch}
              onClick={() => void deleteSelected()}
            >
              {deletingBatch ? 'Suppression…' : `Supprimer la sélection (${selectedIds.size})`}
            </button>
          </div>
        </section>
      )}

      <div className="space-y-4">
        {catalog.categories.map((category) => (
          <CategoryNode
            key={category.id}
            node={category}
            depth={0}
            onUpdate={updateCategory}
            onCreateSub={(parentId, name) => void createFolder(parentId, name)}
            onDelete={(id) => void deleteCategory(id)}
            onToggleChannel={updateChannel}
            onTest={testChannel}
            onReorder={(id, sortOrder) => void updateCategory(id, { sortOrder })}
            onMoveParent={(id, parentId) => void updateCategory(id, { parentId })}
            tests={tests}
            busy={busy}
            orderMap={orderMap}
            allFlat={allFlat}
            childrenByParent={childrenByParent}
            getChannels={getChannels}
            isChannelsLoading={isChannelsLoading}
            ensureChannels={ensureChannels}
            loadMoreChannels={loadMoreChannels}
          />
        ))}
        {catalog.uncategorizedCount > 0 && (
          <section className="card overflow-hidden">
            <button
              type="button"
              className="flex w-full items-center justify-between border-b border-border p-4 text-left font-semibold hover:bg-surface-2/60"
              onClick={() => setUncategorizedOpen((value) => { const next = !value; if (next) ensureChannels('none'); return next; })}
            >
              <span>Sans dossier ({catalog.uncategorizedCount})</span>
              <span className="text-muted">{uncategorizedOpen ? '▾' : '▸'}</span>
            </button>
            {uncategorizedOpen && (
              <>
                <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface-2/40 p-3">
                  <button
                    type="button"
                    className={`btn ${uncatSelectMode ? 'btn-danger' : ''}`}
                    onClick={() => { setUncatSelectMode((value) => !value); setUncatSelected(new Set()); }}
                  >
                    {uncatSelectMode ? 'Quitter la sélection' : 'Sélectionner'}
                  </button>
                  {uncatSelectMode && (
                    <>
                      <button type="button" className="btn" disabled={checkingAllUncat} onClick={() => void checkAllUncategorized()}>
                        {checkingAllUncat ? 'Sélection…' : `Tout cocher (${catalog.uncategorizedCount})`}
                      </button>
                      <button type="button" className="btn" onClick={() => setUncatSelected(new Set())}>Décocher</button>
                      <span className="text-sm text-muted">{uncatSelected.size} sélectionnée(s)</span>
                      <button
                        type="button"
                        className="btn btn-danger ml-auto"
                        disabled={uncatSelected.size === 0 || deletingChannels}
                        onClick={() => void deleteUncatSelected()}
                      >
                        {deletingChannels ? 'Suppression…' : `Supprimer la sélection (${uncatSelected.size})`}
                      </button>
                    </>
                  )}
                </div>
                {pages['none'] ? (
                  <ChannelList
                    page={pages['none']}
                    onToggle={updateChannel}
                    onTest={testChannel}
                    tests={tests}
                    busy={busy}
                    onLoadMore={pages['none'].items.length < pages['none'].total ? () => void fetchPage(null, 'append') : undefined}
                    selectable={uncatSelectMode}
                    selectedIds={uncatSelected}
                    onSelect={toggleUncatSelected}
                  />
                ) : (
                  <div className="p-3 text-sm text-muted">{loadingPages['none'] ? 'Chargement des chaînes…' : 'Aucune chaîne.'}</div>
                )}
              </>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
