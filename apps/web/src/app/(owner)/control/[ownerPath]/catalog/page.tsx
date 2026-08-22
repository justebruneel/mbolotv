'use client';

import type { OwnerCatalog, OwnerCategory, OwnerChannel } from '@mbolo/contracts';
import { useEffect, useState } from 'react';
import { ownerApi } from '../../../../../features/owner/api/owner-api';

type Tests = Record<string, string>;

function ChannelRow({ channel, onToggle, onTest, tests, busy }: { channel: OwnerChannel; onToggle: (id: string, visible: boolean) => void; onTest: (id: string) => void; tests: Tests; busy: string | null }) {
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
}

function CategoryNode({ node, depth, onUpdate, onCreateSub, onToggleChannel, onTest, tests, busy }: {
  node: OwnerCategory;
  depth: number;
  onUpdate: (id: string, patch: { name?: string; isVisible?: boolean }) => void;
  onCreateSub: (parentId: string, name: string) => void;
  onToggleChannel: (id: string, visible: boolean) => void;
  onTest: (id: string) => void;
  tests: Tests;
  busy: string | null;
}) {
  const [open, setOpen] = useState(depth === 0);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(node.name);
  const [subName, setSubName] = useState('');
  const childCount = (node.children ?? []).length;
  const dimmed = !node.effectiveVisible;

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
        <label className="flex items-center gap-2 text-sm" title={dimmed ? 'Masqué (un dossier parent est masqué)' : 'Visible'}>
          <input type="checkbox" checked={node.isVisible} onChange={(event) => onUpdate(node.id, { isVisible: event.target.checked })} /> Publié
        </label>
        <button type="button" className="btn btn-danger" onClick={() => setEditing(true)}>Renommer</button>
      </div>

      {open && (
        <div className="divide-y divide-border/70">
          {node.channels.map((channel) => (
            <ChannelRow key={channel.id} channel={channel} onToggle={onToggleChannel} onTest={onTest} tests={tests} busy={busy} />
          ))}

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
            <CategoryNode key={child.id} node={child} depth={depth + 1} onUpdate={onUpdate} onCreateSub={onCreateSub} /* sub-subfolders reuse root create via node id */
              onToggleChannel={onToggleChannel} onTest={onTest} tests={tests} busy={busy} />
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

  useEffect(() => { void reload(); }, []);

  async function reload(): Promise<void> {
    try { setCatalog(await ownerApi.catalog()); setError(null); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Connexion propriétaire requise.'); }
  }
  async function updateCategory(id: string, patch: { name?: string; isVisible?: boolean }): Promise<void> {
    setBusy(id); try { setCatalog(await ownerApi.categories.update(id, patch)); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Modification impossible.'); } finally { setBusy(null); }
  }
  async function createFolder(parentId: string | null, name: string): Promise<void> {
    const key = parentId ?? 'root';
    setBusy(`create:${key}`); try { setCatalog(await ownerApi.categories.create({ name, parentId })); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Création impossible.'); } finally { setBusy(null); }
  }
  async function updateChannel(id: string, isVisible: boolean): Promise<void> {
    setBusy(id); try { setCatalog(await ownerApi.channels.update(id, { isVisible })); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Modification impossible.'); } finally { setBusy(null); }
  }
  async function testChannel(id: string): Promise<void> {
    setBusy(`test:${id}`); setTests((current) => ({ ...current, [id]: 'test…' }));
    try { const result = await ownerApi.channels.test(id); setTests((current) => ({ ...current, [id]: result.ok ? 'OK' : 'Hors ligne' })); }
    catch (reason) { setTests((current) => ({ ...current, [id]: reason instanceof Error ? reason.message : 'Test impossible' })); }
    finally { setBusy(null); }
  }

  if (error && !catalog) return <main className="p-6"><div className="card p-6 text-sm text-danger">{error}. <a className="font-semibold text-accent hover:underline" href="/owner/login">Se connecter</a></div></main>;
  if (!catalog) return <main className="p-6 text-sm text-muted">Chargement du catalogue…</main>;

  return (
    <main className="space-y-6 p-6">
      <header>
        <p className="text-xs font-semibold uppercase tracking-widest text-accent">Publication</p>
        <h1 className="mt-2 text-2xl font-bold">Catalogue public</h1>
        <p className="mt-1 text-sm text-muted">Renommez les dossiers, masquez ce qui ne doit pas sortir et testez les chaînes avant publication. Un dossier masqué masque aussi ses sous-dossiers et ses chaînes.</p>
      </header>

      {error && <p className="card border-danger/30 bg-danger-muted p-3 text-sm text-danger">{error}</p>}

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
            tests={tests}
            busy={busy}
          />
        ))}
        {catalog.uncategorized.length > 0 && (
          <section className="card overflow-hidden">
            <div className="border-b border-border p-4 font-semibold">Sans dossier</div>
            <div className="divide-y divide-border/70">
              {catalog.uncategorized.map((channel) => (
                <ChannelRow key={channel.id} channel={channel} onToggle={updateChannel} onTest={testChannel} tests={tests} busy={busy} />
              ))}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
