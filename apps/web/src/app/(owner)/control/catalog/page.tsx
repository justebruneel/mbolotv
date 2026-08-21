'use client';

import type { OwnerCatalog } from '@mbolo/contracts';
import { useEffect, useState } from 'react';
import { ownerApi } from '../../../../../features/owner/api/owner-api';

export default function CatalogControlPage() {
  const [catalog, setCatalog] = useState<OwnerCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, string>>({});

  useEffect(() => { ownerApi.catalog().then(setCatalog).catch((reason) => setError(reason instanceof Error ? reason.message : 'Connexion propriétaire requise.')); }, []);
  async function saveCategory(id: string, name: string, isVisible: boolean): Promise<void> { setBusy(id); try { setCatalog(await ownerApi.categories.update(id, { name, isVisible })); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Modification impossible.'); } finally { setBusy(null); } }
  async function toggleChannel(id: string, isVisible: boolean): Promise<void> { setBusy(id); try { setCatalog(await ownerApi.channels.update(id, { isVisible })); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Modification impossible.'); } finally { setBusy(null); } }
  async function testChannel(id: string): Promise<void> { setBusy(`test:${id}`); try { const result = await ownerApi.channels.test(id); setTests((current) => ({ ...current, [id]: result.ok ? 'OK' : 'Hors ligne' })); } catch (reason) { setTests((current) => ({ ...current, [id]: reason instanceof Error ? reason.message : 'Test impossible' })); } finally { setBusy(null); } }

  if (error && !catalog) return <main className="p-6"><div className="card p-6 text-sm text-danger">{error}. <a className="font-semibold text-accent hover:underline" href="/owner/login">Se connecter</a></div></main>;
  if (!catalog) return <main className="p-6 text-sm text-muted">Chargement du catalogue…</main>;
  return (
    <main className="space-y-6 p-6">
      <header><p className="text-xs font-semibold uppercase tracking-widest text-accent">Publication</p><h1 className="mt-2 text-2xl font-bold">Catalogue public</h1><p className="mt-1 text-sm text-muted">Renommez les dossiers, masquez ce qui ne doit pas sortir et testez les chaînes avant publication.</p></header>
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="space-y-4">
        {catalog.categories.map((category) => <section key={category.id} className="card overflow-hidden">
          <div className="flex flex-wrap items-center gap-3 border-b border-border p-4">
            <input defaultValue={category.name} id={`category-${category.id}`} className="min-w-[220px] flex-1 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm font-semibold" />
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" defaultChecked={category.isVisible} id={`visible-${category.id}`} /> Publié</label>
            <button className="btn btn-primary" disabled={busy === category.id} onClick={() => saveCategory(category.id, (document.getElementById(`category-${category.id}`) as HTMLInputElement).value, (document.getElementById(`visible-${category.id}`) as HTMLInputElement).checked)}>{busy === category.id ? 'Enregistrement…' : 'Enregistrer'}</button>
          </div>
          <div className="divide-y divide-border/70">{category.channels.map((channel) => <ChannelRow key={channel.id} channel={channel} busy={busy} test={tests[channel.id]} onToggle={toggleChannel} onTest={testChannel} />)}</div>
        </section>)}
        {catalog.uncategorized.length > 0 && <section className="card overflow-hidden"><div className="border-b border-border p-4 font-semibold">Sans dossier</div><div className="divide-y divide-border/70">{catalog.uncategorized.map((channel) => <ChannelRow key={channel.id} channel={channel} busy={busy} test={tests[channel.id]} onToggle={toggleChannel} onTest={testChannel} />)}</div></section>}
      </div>
    </main>
  );
}

function ChannelRow({ channel, busy, test, onToggle, onTest }: { channel: OwnerCatalog['categories'][number]['channels'][number]; busy: string | null; test?: string; onToggle: (id: string, visible: boolean) => Promise<void>; onTest: (id: string) => Promise<void> }) {
  return <div className="flex flex-wrap items-center gap-3 px-4 py-3"><div className="min-w-[220px] flex-1"><p className="text-sm font-medium">{channel.name}</p><p className="text-xs text-muted">{channel.variantsCount} source(s) · {channel.healthStatus ?? 'non testé'}</p></div><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={channel.isVisible} disabled={busy === channel.id} onChange={(event) => onToggle(channel.id, event.target.checked)} /> Publié</label><button className="btn" disabled={busy !== null} onClick={() => onTest(channel.id)}>{busy === `test:${channel.id}` ? 'Test…' : 'Tester'}</button>{test && <span className={`text-xs font-semibold ${test === 'OK' ? 'text-success' : 'text-danger'}`}>{test}</span>}</div>;
}
