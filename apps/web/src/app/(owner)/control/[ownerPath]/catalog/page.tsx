'use client';

import type { OwnerCatalog, OwnerCategory, OwnerChannel } from '@mbolo/contracts';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ownerApi } from '../../../../../features/owner/api/owner-api';

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

const ChannelRow = memo(function ChannelRow({ channel, onToggle, onTest, tests, busy }: { channel: OwnerChannel; onToggle: (id: string, visible: boolean) => void; onTest: (id: string) => void; tests: Tests; busy: string | null }) {
  const test = tests[channel.id];
  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3">
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

function ChannelList({ page, onToggle, onTest, tests, busy, onLoadMore }: { page: ChannelPage; onToggle: (id: string, visible: boolean) => void; onTest: (id: string) => void; tests: Tests; busy: string | null; onLoadMore?: () => void }) {
  return (
    <div className="divide-y divide-border/70">
      {page.items.map((channel) => (
        <ChannelRow key={channel.id} channel={channel} onToggle={onToggle} onTest={onTest} tests={tests} busy={busy} />
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

function CategoryNode({ node, depth, onUpdate, onCreateSub, onToggleChannel, onTest, onReorder, onMoveParent, tests, busy, orderMap, allFlat, childrenByParent, getChannels, isChannelsLoading, ensureChannels, loadMoreChannels }: {
  node: OwnerCategory;
  depth: number;
  onUpdate: (id: string, patch: { name?: string; isVisible?: boolean }) => void;
  onCreateSub: (parentId: string, name: string) => void;
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
            <CategoryNode key={child.id} node={child} depth={depth + 1} onUpdate={onUpdate} onCreateSub={onCreateSub} onToggleChannel={onToggleChannel} onTest={onTest} onReorder={onReorder} onMoveParent={onMoveParent} tests={tests} busy={busy} orderMap={orderMap} allFlat={allFlat} childrenByParent={childrenByParent} getChannels={getChannels} isChannelsLoading={isChannelsLoading} ensureChannels={ensureChannels} loadMoreChannels={loadMoreChannels} />
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
      </section>

      <div className="space-y-4">
        {catalog.categories.map((category) => (
          <CategoryNode
            key={category.id}
            node={category}
            depth={0}
            onUpdate={updateCategory}
            onCreateSub={(parentId, name) => void createFolder(parentId, name)}
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
              pages['none'] ? (
                <ChannelList page={pages['none']} onToggle={updateChannel} onTest={testChannel} tests={tests} busy={busy} onLoadMore={pages['none'].items.length < pages['none'].total ? () => void fetchPage(null, 'append') : undefined} />
              ) : (
                <div className="p-3 text-sm text-muted">{loadingPages['none'] ? 'Chargement des chaînes…' : 'Aucune chaîne.'}</div>
              )
            )}
          </section>
        )}
      </div>
    </main>
  );
}
