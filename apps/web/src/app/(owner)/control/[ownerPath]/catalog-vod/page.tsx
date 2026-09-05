'use client';

import type { OwnerVodAvailableCategory, OwnerVodCatalog, OwnerVodFolder, OwnerVodItemSummary, VodFolderKind } from '@mbolo/contracts';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ownerApi } from '../../../../../features/owner/api/owner-api';
import { ParentPicker } from '../../../../../features/owner/components/parent-picker';
import { buildChildrenByParent, buildOrderMap, flattenTree, type OrderInfo } from '../../../../../features/owner/components/tree-utils';

const PAGE_SIZE = 50;
// Comme côté chaînes : les gros dossiers restent fermés pour ne pas déclencher
// des dizaines de requêtes paginées au premier rendu.
const AUTO_OPEN_MAX_ITEMS = 200;
const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;
// Au-delà, le quota YouTube quotidien (search=100 unités/appel) devient tendu.
const QUOTA_WARNING_SOURCES = 5;

type ItemPage = { items: OwnerVodItemSummary[]; total: number };

function pageKey(folderId: string | null): string {
  return folderId ?? 'none';
}

function normTitle(value: string): string {
  return value.trim().toLowerCase();
}

const MatchedBadge = memo(function MatchedBadge({ matchedBy }: { matchedBy: OwnerVodItemSummary['matchedBy'] }) {
  if (matchedBy === 'RULE') return <span className="rounded-md bg-accent/15 px-1.5 py-0.5 text-[10px] font-bold uppercase text-accent" title="Apporté par une règle de catégorie : le retirer manuellement ne changera rien tant que la règle existe.">règle</span>;
  if (matchedBy === 'BOTH') return <span className="rounded-md bg-surface-3 px-1.5 py-0.5 text-[10px] font-bold uppercase text-muted" title="À la fois par une règle et par une affectation manuelle (redondant).">règle + manuel</span>;
  return <span className="rounded-md bg-surface-3 px-1.5 py-0.5 text-[10px] font-bold uppercase text-muted" title="Affecté manuellement à ce dossier.">manuel</span>;
});

const ItemRow = memo(function ItemRow({ item, folderId, onToggleVisible, onRemove, busy, selectable, selected, onSelect }: {
  item: OwnerVodItemSummary;
  folderId: string | null;
  onToggleVisible: (item: OwnerVodItemSummary, visible: boolean) => void;
  onRemove: (folderId: string, item: OwnerVodItemSummary) => void;
  busy: string | null;
  selectable?: boolean;
  selected?: boolean;
  onSelect?: (id: string) => void;
}) {
  const removable = folderId !== null && (item.matchedBy === 'MANUAL' || item.matchedBy === 'BOTH');
  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3">
      {selectable && (
        <input type="checkbox" aria-label={`Sélectionner ${item.title}`} checked={Boolean(selected)} onChange={() => onSelect?.(item.id)} />
      )}
      <div className="min-w-[200px] flex-1">
        <p className="text-sm font-medium">{item.title}</p>
        <p className="text-xs text-muted">
          {item.kind === 'MOVIE' ? 'film' : 'série'}
          {item.categoryTitle ? ` · ${item.categoryTitle}` : ' · sans catégorie fournisseur'}
        </p>
      </div>
      {folderId !== null && <MatchedBadge matchedBy={item.matchedBy} />}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={item.isVisible} disabled={busy === `item:${item.id}`} onChange={(event) => onToggleVisible(item, event.target.checked)} /> Publié
      </label>
      {removable && (
        <button type="button" className="btn" disabled={busy === `remove:${item.id}`} onClick={() => onRemove(folderId, item)}>Retirer</button>
      )}
    </div>
  );
});

function ItemList({ page, folderId, onToggleVisible, onRemove, busy, onLoadMore, selectable, selectedIds, onSelect }: {
  page: ItemPage;
  folderId: string | null;
  onToggleVisible: (item: OwnerVodItemSummary, visible: boolean) => void;
  onRemove: (folderId: string, item: OwnerVodItemSummary) => void;
  busy: string | null;
  onLoadMore?: () => void;
  selectable?: boolean;
  selectedIds?: Set<string>;
  onSelect?: (id: string) => void;
}) {
  return (
    <div className="divide-y divide-border/70">
      {page.items.map((item) => (
        <ItemRow key={item.id} item={item} folderId={folderId} onToggleVisible={onToggleVisible} onRemove={onRemove} busy={busy} selectable={selectable} selected={selectedIds?.has(item.id)} onSelect={onSelect} />
      ))}
      {onLoadMore && page.items.length < page.total && (
        <div className="bg-surface-2/40 p-3 text-center">
          <button type="button" className="btn" onClick={onLoadMore}>Afficher plus ({page.items.length}/{page.total})</button>
        </div>
      )}
    </div>
  );
}

// Règles automatiques : libellés categoryTitle du fournisseur → dossier.
// Edition en brouillon local, un seul PUT (remplacement intégral) à la fin.
function RuleEditor({ node, available, busy, ensureAvailable, onSave }: {
  node: OwnerVodFolder;
  available: OwnerVodAvailableCategory[] | null;
  busy: string | null;
  ensureAvailable: () => void;
  onSave: (folderId: string, titles: string[]) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string[] | null>(null);
  const [query, setQuery] = useState('');
  const titles = draft ?? node.rules.map((rule) => rule.categoryTitle);
  const dirty = draft !== null && (draft.length !== node.rules.length || draft.some((title, index) => normTitle(title) !== normTitle(node.rules[index]?.categoryTitle ?? '')));
  const existing = useMemo(() => new Set(titles.map(normTitle)), [titles]);
  const suggestions = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (available ?? [])
      .filter((entry) => !existing.has(normTitle(entry.title)) && (!q || entry.title.toLowerCase().includes(q)))
      .slice(0, 8);
  }, [available, existing, query]);

  useEffect(() => { if (open) ensureAvailable(); }, [open, ensureAvailable]);

  function addTitle(title: string): void {
    const clean = title.trim();
    if (!clean || existing.has(normTitle(clean))) return;
    setDraft([...titles, clean]);
    setQuery('');
  }

  return (
    <div className="border-b border-border/70 bg-surface-2/30 px-4 py-3">
      <button type="button" className="text-sm font-semibold" onClick={() => setOpen((value) => !value)}>
        {open ? '▾' : '▸'} Alimentation automatique ({node.rules.length} règle{node.rules.length > 1 ? 's' : ''})
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          <p className="text-xs text-muted">Chaque catégorie fournisseur ajoutée ici alimente le dossier à chaque import — sans intervention.</p>
          <div className="flex flex-wrap gap-1.5">
            {titles.map((title) => (
              <span key={title} className="inline-flex items-center gap-1 rounded-full bg-surface-3 px-2.5 py-1 text-xs font-medium">
                {title}
                <button type="button" aria-label={`Retirer la règle ${title}`} className="text-muted hover:text-danger" onClick={() => setDraft(titles.filter((value) => value !== title))}>✕</button>
              </span>
            ))}
            {titles.length === 0 && <span className="text-xs text-muted">Aucune règle : ce dossier ne reçoit que des ajouts manuels.</span>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={query}
              placeholder="Ajouter une catégorie (ex. « Action », « Nollywood »)…"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter' && query.trim()) addTitle(query); }}
              className="min-w-[220px] flex-1 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm"
            />
            {query.trim() && !suggestions.some((entry) => normTitle(entry.title) === normTitle(query)) && (
              <button type="button" className="btn" onClick={() => addTitle(query)}>+ « {query.trim()} »</button>
            )}
          </div>
          {available === null ? (
            <p className="text-xs text-muted">Chargement des catégories de l’import…</p>
          ) : (
            <div className="flex flex-wrap gap-1">
              {suggestions.map((entry) => (
                <button key={entry.key} type="button" className="rounded-md bg-surface-2 px-2 py-1 text-xs font-medium hover:bg-surface-3" onClick={() => addTitle(entry.title)}>
                  {entry.title} <span className="text-muted">({entry.count})</span>
                </button>
              ))}
              {query.trim() && suggestions.length === 0 && <span className="text-xs text-muted">Aucune catégorie importée ne correspond — utilisez le bouton + ci-dessus pour la créer quand même.</span>}
            </div>
          )}
          {dirty && (
            <div className="flex items-center gap-2">
              <button type="button" className="btn btn-primary" disabled={busy === `rules:${node.id}`} onClick={() => { void onSave(node.id, titles).then(() => setDraft(null)); }}>
                {busy === `rules:${node.id}` ? 'Enregistrement…' : `Enregistrer les règles (${titles.length})`}
              </button>
              <button type="button" className="btn" onClick={() => { setDraft(null); setQuery(''); }}>Annuler</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Sources YouTube du dossier : table VodYoutubeSource (allowlist dynamique).
function YoutubeEditor({ node, busy, onCreate, onPatch, onRemove }: {
  node: OwnerVodFolder;
  busy: string | null;
  onCreate: (folderId: string, channelId: string, label: string | null) => Promise<void>;
  onPatch: (id: string, patch: { label?: string | null; isActive?: boolean; sortOrder?: number }) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [channelId, setChannelId] = useState('');
  const [label, setLabel] = useState('');
  const sources = useMemo(() => [...node.youtubeSources].sort((a, b) => a.sortOrder - b.sortOrder), [node.youtubeSources]);
  const activeCount = sources.filter((source) => source.isActive).length;
  const valid = CHANNEL_ID_RE.test(channelId.trim());

  return (
    <div className="border-b border-border/70 bg-surface-2/30 px-4 py-3">
      <button type="button" className="text-sm font-semibold" onClick={() => setOpen((value) => !value)}>
        {open ? '▾' : '▸'} Chaînes YouTube rattachées ({sources.length})
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          <p className="text-xs text-muted">Chaque chaîne active devient un rail YouTube dans ce dossier de l’onglet Films/Séries. Clé API non exposée, seules ces chaînes sont interrogées.</p>
          {activeCount > QUOTA_WARNING_SOURCES && (
            <p className="rounded-lg border border-danger/30 bg-danger-muted p-2 text-xs text-danger">
              {activeCount} chaînes actives : le quota YouTube (search = 100 unités/appel) se consomme vite avec autant de rails. Désactivez celles du moment.
            </p>
          )}
          {sources.map((source, index) => (
            <div key={source.id} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="min-w-[160px] flex-1 truncate font-medium">{source.label ?? source.channelId}</span>
              <span className="font-mono text-xs text-muted">{source.channelId}</span>
              <button type="button" className="btn" disabled={index === 0 || busy === `yt:${source.id}`} onClick={() => void onPatch(source.id, { sortOrder: index - 1 })} aria-label="Monter">↑</button>
              <button type="button" className="btn" disabled={index === sources.length - 1 || busy === `yt:${source.id}`} onClick={() => void onPatch(source.id, { sortOrder: index + 1 })} aria-label="Descendre">↓</button>
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={source.isActive} disabled={busy === `yt:${source.id}`} onChange={(event) => void onPatch(source.id, { isActive: event.target.checked }) } /> Active
              </label>
              <button type="button" className="btn btn-danger" disabled={busy === `yt:${source.id}`} onClick={() => { if (window.confirm(`Retirer la chaîne « ${source.label ?? source.channelId} » de ce dossier ?`)) void onRemove(source.id); }}>Retirer</button>
            </div>
          ))}
          {sources.length === 0 && <p className="text-xs text-muted">Aucune chaîne rattachée.</p>}
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={channelId}
              placeholder="ID de chaîne (UC…)"
              onChange={(event) => setChannelId(event.target.value)}
              className={`min-w-[200px] flex-1 rounded-lg border bg-surface px-3 py-1.5 text-sm font-mono ${channelId.trim() && !valid ? 'border-danger/50' : 'border-border'}`}
            />
            <input
              value={label}
              placeholder="Nom affiché (optionnel)"
              onChange={(event) => setLabel(event.target.value)}
              className="min-w-[160px] flex-1 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm"
            />
            <button
              type="button"
              className="btn btn-primary"
              disabled={!valid || sources.length >= 10 || busy === `yt:create:${node.id}`}
              onClick={() => { void onCreate(node.id, channelId.trim(), label.trim() || null).then(() => { setChannelId(''); setLabel(''); }); }}
            >
              {sources.length >= 10 ? 'Maximum atteint (10)' : '+ Chaîne'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function VodFolderNode({ node, depth, onUpdate, onCreateSub, onDelete, onToggleItem, onRemoveItem, onReorder, onMoveParent, busy, orderMap, allFlat, childrenByParent, getItems, isItemsLoading, ensureItems, loadMoreItems, available, ensureAvailable, onSaveRules, onCreateYoutube, onPatchYoutube, onRemoveYoutube, onRefresh }: {
  node: OwnerVodFolder;
  depth: number;
  onUpdate: (id: string, patch: { name?: string; kind?: VodFolderKind; isVisible?: boolean; sortOrder?: number; parentId?: string | null }) => void;
  onCreateSub: (parentId: string, name: string, kind: VodFolderKind) => void;
  onDelete: (id: string) => void;
  onToggleItem: (item: OwnerVodItemSummary, visible: boolean) => void;
  onRemoveItem: (folderId: string, item: OwnerVodItemSummary) => void;
  onReorder: (id: string, sortOrder: number) => void;
  onMoveParent: (id: string, parentId: string | null) => void;
  busy: string | null;
  orderMap: Map<string, OrderInfo<OwnerVodFolder>>;
  allFlat: OwnerVodFolder[];
  childrenByParent: Map<string | null, OwnerVodFolder[]>;
  getItems: (folderId: string) => ItemPage | undefined;
  isItemsLoading: (folderId: string) => boolean;
  ensureItems: (folderId: string) => void;
  loadMoreItems: (folderId: string) => void;
  available: OwnerVodAvailableCategory[] | null;
  ensureAvailable: () => void;
  onSaveRules: (folderId: string, titles: string[]) => Promise<void>;
  onCreateYoutube: (folderId: string, channelId: string, label: string | null) => Promise<void>;
  onPatchYoutube: (id: string, patch: { label?: string | null; isActive?: boolean; sortOrder?: number }) => Promise<void>;
  onRemoveYoutube: (id: string) => Promise<void>;
  onRefresh: (folderId: string) => void;
}) {
  const [open, setOpen] = useState(depth === 0 && node.itemCount <= AUTO_OPEN_MAX_ITEMS);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(node.name);
  const [subName, setSubName] = useState('');
  const [subKind, setSubKind] = useState<VodFolderKind>('BOTH');
  const childCount = (node.children ?? []).length;
  const dimmed = !node.effectiveVisible;
  const order = orderMap.get(node.id);
  const canUp = order ? order.index > 0 : false;
  const canDown = order ? order.index < order.siblings.length - 1 : false;
  const items = getItems(node.id);
  const itemsLoading = isItemsLoading(node.id);
  const activeSources = node.youtubeSources.filter((source) => source.isActive).length;

  useEffect(() => { if (open) ensureItems(node.id); }, [open, ensureItems, node.id]);

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
        <select
          value={node.kind}
          disabled={busy === node.id}
          onChange={(event) => onUpdate(node.id, { kind: event.target.value as VodFolderKind })}
          className="rounded-lg border border-border bg-surface-2 px-2 py-1 text-xs font-medium"
          title="Type de contenus que ce dossier affiche"
        >
          <option value="MOVIE">Films</option>
          <option value="SERIES">Séries</option>
          <option value="BOTH">Films + Séries</option>
        </select>
        <span className="text-xs text-muted">
          {node.itemCount} titre{node.itemCount > 1 ? 's' : ''}
          {childCount > 0 ? ` · ${childCount} sous-dossier${childCount > 1 ? 's' : ''}` : ''}
          {activeSources > 0 ? ` · ${activeSources} chaîne${activeSources > 1 ? 's' : ''} YouTube` : ''}
        </span>
        <button type="button" className="btn" disabled={!canUp || busy === node.id} onClick={() => order && onReorder(node.id, order.index - 1)} aria-label="Monter">↑</button>
        <button type="button" className="btn" disabled={!canDown || busy === node.id} onClick={() => order && onReorder(node.id, order.index + 1)} aria-label="Descendre">↓</button>
        <label className="flex items-center gap-2 text-sm" title={dimmed ? 'Masqué (un dossier parent est masqué)' : 'Visible'}>
          <input type="checkbox" checked={node.isVisible} disabled={busy === node.id} onChange={(event) => onUpdate(node.id, { isVisible: event.target.checked })} /> Publié
        </label>
        <button type="button" className="btn" onClick={() => setEditing(true)}>Renommer</button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={busy === node.id}
          onClick={() => {
            if (window.confirm(`Supprimer le dossier « ${node.name} » ?\n\nLes titres repassent en « sans dossier » (aucun n'est supprimé de la base), les sous-dossiers remontent d'un niveau. Un autre dossier dont une règle correspond les réaffichera.`)) onDelete(node.id);
          }}
        >
          Supprimer
        </button>
        <ParentPicker allFlat={allFlat} childrenByParent={childrenByParent} nodeId={node.id} currentParentId={node.parentId} onMove={(parentId) => onMoveParent(node.id, parentId)} />
      </div>

      {open && (
        <div>
          <RuleEditor node={node} available={available} busy={busy} ensureAvailable={ensureAvailable} onSave={onSaveRules} />
          <YoutubeEditor node={node} busy={busy} onCreate={onCreateYoutube} onPatch={onPatchYoutube} onRemove={onRemoveYoutube} />
          {items ? (
            <ItemList page={items} folderId={node.id} onToggleVisible={onToggleItem} onRemove={onRemoveItem} busy={busy} onLoadMore={items.items.length < items.total ? () => loadMoreItems(node.id) : undefined} />
          ) : (
            <div className="border-b border-border/70 p-3 text-sm text-muted">{itemsLoading ? 'Chargement des titres…' : 'Aucun titre dans ce dossier.'}</div>
          )}
          <div className="flex flex-wrap items-center gap-2 bg-surface-2/40 p-3">
            <button type="button" className="btn shrink-0" disabled={busy === `refresh:${node.id}`} onClick={() => onRefresh(node.id)}>{busy === `refresh:${node.id}` ? 'Actualisation…' : 'Actualiser'}</button>
            <input
              value={subName}
              placeholder="Nouveau sous-dossier…"
              onChange={(event) => setSubName(event.target.value)}
              className="min-w-[180px] flex-1 rounded-lg border border-border bg-surface-2 px-3 py-1.5 text-sm"
            />
            <select value={subKind} onChange={(event) => setSubKind(event.target.value as VodFolderKind)} className="rounded-lg border border-border bg-surface-2 px-2 py-1.5 text-sm">
              <option value="MOVIE">Films</option>
              <option value="SERIES">Séries</option>
              <option value="BOTH">Films + Séries</option>
            </select>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!subName.trim()}
              onClick={() => { if (subName.trim()) { onCreateSub(node.id, subName.trim(), subKind); setSubName(''); } }}
            >
              + Sous-dossier
            </button>
          </div>

          {(node.children ?? []).map((child) => (
            <div key={child.id} className="border-t border-border/70 p-3">
              <VodFolderNode node={child} depth={depth + 1} onUpdate={onUpdate} onCreateSub={onCreateSub} onDelete={onDelete} onToggleItem={onToggleItem} onRemoveItem={onRemoveItem} onReorder={onReorder} onMoveParent={onMoveParent} busy={busy} orderMap={orderMap} allFlat={allFlat} childrenByParent={childrenByParent} getItems={getItems} isItemsLoading={isItemsLoading} ensureItems={ensureItems} loadMoreItems={loadMoreItems} available={available} ensureAvailable={ensureAvailable} onSaveRules={onSaveRules} onCreateYoutube={onCreateYoutube} onPatchYoutube={onPatchYoutube} onRemoveYoutube={onRemoveYoutube} onRefresh={onRefresh} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export default function VodCatalogControlPage() {
  const [catalog, setCatalog] = useState<OwnerVodCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rootName, setRootName] = useState('');
  const [rootKind, setRootKind] = useState<VodFolderKind>('BOTH');
  const [pages, setPages] = useState<Record<string, ItemPage>>({});
  const [loadingPages, setLoadingPages] = useState<Record<string, boolean>>({});
  const loadedRef = useRef<Set<string>>(new Set());
  const pagesRef = useRef<Record<string, ItemPage>>({});
  pagesRef.current = pages;
  const loadingPagesRef = useRef<Record<string, boolean>>({});
  loadingPagesRef.current = loadingPages;
  const [searchQuery, setSearchQuery] = useState('');
  const [searchPage, setSearchPage] = useState<ItemPage | null>(null);
  const searchPageRef = useRef<ItemPage | null>(null);
  searchPageRef.current = searchPage;
  const [unsortedOpen, setUnsortedOpen] = useState(false);
  // Sélection « sans dossier » → affectation de masse à un dossier.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [assigning, setAssigning] = useState(false);
  const [assignTarget, setAssignTarget] = useState<string | null>(null);
  const [available, setAvailable] = useState<OwnerVodAvailableCategory[] | null>(null);
  const availableRef = useRef(false);

  const orderMap = useMemo(() => (catalog ? buildOrderMap(catalog.folders) : new Map<string, OrderInfo<OwnerVodFolder>>()), [catalog]);
  const allFlat = useMemo(() => (catalog ? flattenTree(catalog.folders) : []), [catalog]);
  const childrenByParent = useMemo(() => (catalog ? buildChildrenByParent(catalog.folders) : new Map<string | null, OwnerVodFolder[]>()), [catalog]);

  useEffect(() => { void reload(); }, []);

  // Recherche serveur globale (tous dossiers), débouncée comme le catalogue live.
  useEffect(() => {
    const query = searchQuery.trim();
    if (query.length < 2) { setSearchPage(null); return; }
    const timer = window.setTimeout(async () => {
      try { setSearchPage(await ownerApi.vod.items({ q: query, limit: PAGE_SIZE })); }
      catch (reason) { setError(reason instanceof Error ? reason.message : 'Recherche impossible.'); }
    }, 350);
    return () => window.clearTimeout(timer);
  }, [searchQuery]);

  const fetchPage = useCallback(async (folderId: string | null, mode: 'replace' | 'append'): Promise<void> => {
    const key = pageKey(folderId);
    setLoadingPages((current) => ({ ...current, [key]: true }));
    try {
      const offset = mode === 'append' ? pagesRef.current[key]?.items.length ?? 0 : 0;
      const data = await ownerApi.vod.items({ folderId, limit: PAGE_SIZE, offset });
      setPages((current) => {
        const previous = mode === 'append' ? current[key] : undefined;
        const merged: ItemPage = previous ? { items: [...previous.items, ...data.items], total: data.total } : data;
        return { ...current, [key]: merged };
      });
    } catch (reason) {
      loadedRef.current.delete(key);
      setError(reason instanceof Error ? reason.message : 'Chargement des titres impossible.');
    } finally {
      setLoadingPages((current) => { const next = { ...current }; delete next[key]; return next; });
    }
  }, []);

  const ensureItems = useCallback((folderId: string) => {
    const key = pageKey(folderId);
    if (loadedRef.current.has(key)) return;
    loadedRef.current.add(key);
    void fetchPage(folderId, 'replace');
  }, [fetchPage]);

  const loadMoreItems = useCallback((folderId: string) => { void fetchPage(folderId, 'append'); }, [fetchPage]);
  const getItems = useCallback((folderId: string) => pagesRef.current[pageKey(folderId)], []);
  const isItemsLoading = useCallback((folderId: string) => Boolean(loadingPagesRef.current[pageKey(folderId)]), []);

  const ensureAvailable = useCallback(() => {
    if (availableRef.current) return;
    availableRef.current = true;
    void ownerApi.vod.availableCategories().then(setAvailable).catch(() => { availableRef.current = false; });
  }, []);

  const loadMoreSearch = useCallback(() => {
    const current = searchPageRef.current;
    if (!current || current.items.length >= current.total) return;
    const query = searchQuery.trim();
    void ownerApi.vod.items({ q: query, limit: PAGE_SIZE, offset: current.items.length })
      .then((data) => setSearchPage({ items: [...current.items, ...data.items], total: data.total }))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Recherche impossible.'));
  }, [searchQuery]);

  async function reload(): Promise<void> {
    try { setCatalog(await ownerApi.vod.catalog()); setError(null); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Connexion propriétaire requise.'); }
  }
  // Les mutations renvoient l'arbre complet : on recharge aussi les pages
  // dirty (itemCount, règles et affects ont peut-être bougé).
  async function refreshAll(targetFolderIds: string[] = []): Promise<void> {
    await reload();
    for (const folderId of targetFolderIds) void fetchPage(folderId, 'replace');
  }
  async function updateFolder(id: string, patch: { name?: string; kind?: VodFolderKind; isVisible?: boolean; sortOrder?: number; parentId?: string | null }): Promise<void> {
    setBusy(id); try { setCatalog(await ownerApi.vod.folders.update(id, patch)); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Modification impossible.'); } finally { setBusy(null); }
  }
  async function createFolder(parentId: string | null, name: string, kind: VodFolderKind): Promise<void> {
    const key = parentId ?? 'root';
    setBusy(`create:${key}`); try { setCatalog(await ownerApi.vod.folders.create({ name, kind, parentId })); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Création impossible.'); } finally { setBusy(null); }
  }
  async function deleteFolder(id: string): Promise<void> {
    setBusy(id);
    try {
      setCatalog(await ownerApi.vod.folders.remove(id));
      loadedRef.current.delete(pageKey(id));
      loadedRef.current.delete('none');
      void fetchPage(null, 'replace');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Suppression impossible.'); }
    finally { setBusy(null); }
  }
  async function saveRules(folderId: string, titles: string[]): Promise<void> {
    setBusy(`rules:${folderId}`);
    try {
      setCatalog(await ownerApi.vod.rules.set(folderId, titles));
      void fetchPage(folderId, 'replace');
      void fetchPage(null, 'replace');
      setError(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Enregistrement des règles impossible.'); }
    finally { setBusy(null); }
  }
  async function createYoutube(folderId: string, channelId: string, label: string | null): Promise<void> {
    setBusy(`yt:create:${folderId}`);
    try { setCatalog(await ownerApi.vod.youtube.create(folderId, { channelId, ...(label ? { label } : {}) })); setError(null); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Ajout YouTube impossible.'); }
    finally { setBusy(null); }
  }
  async function patchYoutube(id: string, patch: { label?: string | null; isActive?: boolean; sortOrder?: number }): Promise<void> {
    setBusy(`yt:${id}`);
    try { setCatalog(await ownerApi.vod.youtube.update(id, patch)); setError(null); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Modification YouTube impossible.'); }
    finally { setBusy(null); }
  }
  async function removeYoutube(id: string): Promise<void> {
    setBusy(`yt:${id}`);
    try { setCatalog(await ownerApi.vod.youtube.remove(id)); setError(null); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Retrait YouTube impossible.'); }
    finally { setBusy(null); }
  }

  async function toggleItemVisible(item: OwnerVodItemSummary, visible: boolean): Promise<void> {
    // Patch optimiste local : le PATCH item renvoie sa fiche, pas les listes.
    const apply = (items: OwnerVodItemSummary[]): OwnerVodItemSummary[] => items.map((entry) => (entry.id === item.id ? { ...entry, isVisible: visible } : entry));
    setPages((current) => {
      const next: Record<string, ItemPage> = {};
      for (const [key, page] of Object.entries(current)) next[key] = { ...page, items: apply(page.items) };
      return next;
    });
    setSearchPage((current) => (current ? { ...current, items: apply(current.items) } : current));
    setBusy(`item:${item.id}`);
    try { await ownerApi.vod.assign.setItemFolders(item.id, { folderIds: item.folderIds, isVisible: visible }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Modification impossible.'); await reload(); }
    finally { setBusy(null); }
  }
  async function removeItemFromFolder(folderId: string, item: OwnerVodItemSummary): Promise<void> {
    setBusy(`remove:${item.id}`);
    try {
      await ownerApi.vod.assign.removeFromFolder(folderId, item.id);
      void fetchPage(folderId, 'replace');
      void fetchPage(null, 'replace');
      await reload();
      setError(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Retrait impossible.'); }
    finally { setBusy(null); }
  }
  async function assignSelectedToFolder(): Promise<void> {
    const ids = [...selectedIds];
    if (ids.length === 0 || !assignTarget) return;
    setAssigning(true);
    try {
      await ownerApi.vod.assign.addToFolder(assignTarget, ids.slice(0, 200));
      void fetchPage(assignTarget, 'replace');
      void fetchPage(null, 'replace');
      await reload();
      setSelectedIds(new Set());
      setSelectMode(false);
      setAssignTarget(null);
      setError(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Affectation impossible.'); }
    finally { setAssigning(false); }
  }

  function toggleSelected(id: string): void {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  if (error && !catalog) return <main className="p-6"><div className="card p-6 text-sm text-danger">{error}. <a className="font-semibold text-accent hover:underline" href="/owner/login">Se connecter</a></div></main>;
  if (!catalog) return <main className="p-6 text-sm text-muted">Chargement du catalogue VOD…</main>;

  return (
    <main className="space-y-6 p-6">
      <header>
        <p className="text-xs font-semibold uppercase tracking-widest text-accent">Publication</p>
        <h1 className="mt-2 text-2xl font-bold">Catalogue VOD</h1>
        <p className="mt-1 text-sm text-muted">
          Créez des dossiers de films et séries, alimentez-les automatiquement par catégorie fournisseur (règles) ou titre par titre (manuel), et rattachez-leur des chaînes YouTube.
          Les dossiers visibles apparaissent dans l’onglet Films/Séries de l’app (~6 min de latence, cache edge). Un dossier masqué masque aussi ses sous-dossiers.
        </p>
      </header>

      {error && <p className="card border-danger/30 bg-danger-muted p-3 text-sm text-danger">{error}</p>}

      <section className="card flex flex-wrap items-center gap-3 p-4">
        <input
          value={searchQuery}
          placeholder="Rechercher un titre importé…"
          onChange={(event) => setSearchQuery(event.target.value)}
          className="min-w-[220px] flex-1 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm font-semibold"
        />
        <button type="button" className="btn" onClick={() => { void refreshAll(Object.keys(pagesRef.current).filter((key) => key !== 'none')); void fetchPage(null, 'replace'); }}>Actualiser</button>
      </section>

      {searchPage && (
        <section className="card overflow-hidden">
          <div className="border-b border-border p-4 font-semibold">Résultats ({searchPage.total})</div>
          <ItemList page={searchPage} folderId={null} onToggleVisible={(item, visible) => void toggleItemVisible(item, visible)} onRemove={() => undefined} busy={busy} onLoadMore={searchPage.items.length < searchPage.total ? loadMoreSearch : undefined} />
        </section>
      )}

      <section className="card flex flex-wrap items-center gap-3 p-4">
        <input
          value={rootName}
          placeholder="Nouveau dossier racine…"
          onChange={(event) => setRootName(event.target.value)}
          className="min-w-[220px] flex-1 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm font-semibold"
        />
        <select value={rootKind} onChange={(event) => setRootKind(event.target.value as VodFolderKind)} className="rounded-lg border border-border bg-surface-2 px-2 py-2 text-sm">
          <option value="MOVIE">Films</option>
          <option value="SERIES">Séries</option>
          <option value="BOTH">Films + Séries</option>
        </select>
        <button className="btn btn-primary" disabled={!rootName.trim() || busy === 'create:root'} onClick={() => { if (rootName.trim()) { void createFolder(null, rootName.trim(), rootKind); setRootName(''); } }}>{busy === 'create:root' ? 'Création…' : 'Créer un dossier'}</button>
      </section>

      <div className="space-y-4">
        {catalog.folders.map((folder) => (
          <VodFolderNode
            key={folder.id}
            node={folder}
            depth={0}
            onUpdate={(id, patch) => void updateFolder(id, patch)}
            onCreateSub={(parentId, name, kind) => void createFolder(parentId, name, kind)}
            onDelete={(id) => void deleteFolder(id)}
            onToggleItem={(item, visible) => void toggleItemVisible(item, visible)}
            onRemoveItem={(folderId, item) => void removeItemFromFolder(folderId, item)}
            onReorder={(id, sortOrder) => void updateFolder(id, { sortOrder })}
            onMoveParent={(id, parentId) => void updateFolder(id, { parentId })}
            busy={busy}
            orderMap={orderMap}
            allFlat={allFlat}
            childrenByParent={childrenByParent}
            getItems={getItems}
            isItemsLoading={isItemsLoading}
            ensureItems={ensureItems}
            loadMoreItems={loadMoreItems}
            available={available}
            ensureAvailable={ensureAvailable}
            onSaveRules={(folderId, titles) => saveRules(folderId, titles)}
            onCreateYoutube={(folderId, channelId, label) => createYoutube(folderId, channelId, label)}
            onPatchYoutube={(id, patch) => patchYoutube(id, patch)}
            onRemoveYoutube={(id) => removeYoutube(id)}
            onRefresh={(folderId) => { setBusy(`refresh:${folderId}`); void refreshAll([folderId, 'none']).finally(() => setBusy(null)); }}
          />
        ))}

        {catalog.unsortedCount > 0 && (
          <section className="card overflow-hidden">
            <button
              type="button"
              className="flex w-full items-center justify-between border-b border-border p-4 text-left font-semibold hover:bg-surface-2/60"
              onClick={() => setUnsortedOpen((value) => { const next = !value; if (next) ensureItems('none'); return next; })}
            >
              <span>Sans dossier ({catalog.unsortedCount})</span>
              <span className="text-muted">{unsortedOpen ? '▾' : '▸'}</span>
            </button>
            {unsortedOpen && (
              <>
                <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface-2/40 p-3">
                  <button
                    type="button"
                    className={`btn ${selectMode ? 'btn-danger' : ''}`}
                    onClick={() => { setSelectMode((value) => !value); setSelectedIds(new Set()); setAssignTarget(null); }}
                  >
                    {selectMode ? 'Quitter la sélection' : 'Sélectionner'}
                  </button>
                  {selectMode && (
                    <>
                      <select
                        value={assignTarget ?? ''}
                        onChange={(event) => setAssignTarget(event.target.value || null)}
                        className="min-w-[180px] rounded-lg border border-border bg-surface px-2 py-1.5 text-sm"
                      >
                        <option value="">Choisir un dossier…</option>
                        {allFlat.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
                      </select>
                      <button type="button" className="btn btn-primary" disabled={!assignTarget || selectedIds.size === 0 || assigning} onClick={() => void assignSelectedToFolder()}>
                        {assigning ? 'Ajout…' : `Ajouter ${selectedIds.size} titre(s) au dossier`}
                      </button>
                    </>
                  )}
                </div>
                {pages['none'] ? (
                  <ItemList
                    page={pages['none']}
                    folderId={null}
                    onToggleVisible={(item, visible) => void toggleItemVisible(item, visible)}
                    onRemove={() => undefined}
                    busy={busy}
                    onLoadMore={pages['none'].items.length < pages['none'].total ? () => void fetchPage(null, 'append') : undefined}
                    selectable={selectMode}
                    selectedIds={selectedIds}
                    onSelect={toggleSelected}
                  />
                ) : (
                  <div className="p-3 text-sm text-muted">{loadingPages['none'] ? 'Chargement des titres…' : 'Aucun titre.'}</div>
                )}
              </>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
