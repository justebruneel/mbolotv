'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ownerApi } from '../api/owner-api';

type Action = 'test' | 'import' | 'delete';

const CONFIRM_BY_ACTION: Record<Action, string | null> = {
  test: null,
  import: null,
  delete: `Cette action est définitive : les chaînes de la source seront supprimées.`,
};

export function SourceActions({ sourceId }: { sourceId: string }) {
  const router = useRouter();
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Action | null>(null);

  async function run(action: Action) {
    if (action === 'delete' && !window.confirm(CONFIRM_BY_ACTION.delete ?? 'Confirmer ?')) return;
    setBusy(action);
    setFeedback(null);
    setError(null);
    try {
      if (action === 'test') {
        const result = await ownerApi.sources.test(sourceId);
        setFeedback(
          result.ok
            ? `Test : connexion réussie en ${result.latencyMs ?? '?'} ms.`
            : `Test : échec de connexion. ${result.error ?? ''}`,
        );
      } else if (action === 'import') {
        const run = await ownerApi.sources.import(sourceId);
        setFeedback(`Import programmé : #${run.id}`);
        router.refresh();
      } else {
        await ownerApi.sources.remove(sourceId);
        router.push('/control/sources');
        router.refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action impossible.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => run('test')}
          disabled={busy !== null}
          className="rounded-lg border border-border px-3 py-2 text-sm hover:border-accent disabled:opacity-50"
        >
          {busy === 'test' ? 'Test en cours…' : 'Tester la connexion'}
        </button>
        <button
          onClick={() => run('import')}
          disabled={busy !== null}
          className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-on-accent disabled:opacity-50"
        >
          {busy === 'import' ? 'Planification…' : 'Lancer un import'}
        </button>
        <button
          onClick={() => run('delete')}
          disabled={busy !== null}
          className="rounded-lg border border-red-500/40 px-3 py-2 text-sm text-red-300 hover:bg-red-500/10 disabled:opacity-50"
        >
          {busy === 'delete' ? 'Suppression…' : 'Supprimer'}
        </button>
      </div>
      {feedback && <p className="mt-3 text-sm text-green-400">{feedback}</p>}
      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
    </div>
  );
}