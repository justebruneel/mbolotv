'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ownerApi } from '../api/owner-api';
import {
  IconCheck,
  IconImports,
  IconPlay,
  IconTrash,
  IconX,
} from './ui/icons';

type Action = 'test' | 'import' | 'import-vod' | 'delete';

const CONFIRM_BY_ACTION: Record<Action, string | null> = {
  test: null,
  import: null,
  'import-vod': null,
  delete: 'Cette action est définitive : les chaînes de la source seront supprimées.',
};

export function SourceActions({ sourceId }: { sourceId: string }) {
  const router = useRouter();
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState<Action | null>(null);

  async function run(action: Action) {
    if (action === 'delete' && !window.confirm(CONFIRM_BY_ACTION.delete ?? 'Confirmer ?')) return;
    setBusy(action);
    setFeedback(null);
    try {
      if (action === 'test') {
        const result = await ownerApi.sources.test(sourceId);
        setFeedback(
          result.ok
            ? { ok: true, message: `Connexion réussie en ${result.latencyMs ?? '?'} ms.` }
            : { ok: false, message: `Échec de connexion. ${result.error ?? ''}` },
        );
      } else if (action === 'import') {
        const run = await ownerApi.sources.import(sourceId);
        setFeedback({ ok: true, message: `Import #${run.id} programmé.` });
        router.refresh();
      } else if (action === 'import-vod') {
        const run = await ownerApi.sources.import(sourceId, 'vod');
        setFeedback({ ok: true, message: `Import films & séries #${run.id} programmé (chaînes non touchées).` });
        router.refresh();
      } else {
        await ownerApi.sources.remove(sourceId);
        router.push('/control/sources');
        router.refresh();
      }
    } catch (err) {
      setFeedback({ ok: false, message: err instanceof Error ? err.message : 'Action impossible.' });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col items-start gap-3">
      <div className="flex flex-wrap gap-2">
        <button onClick={() => run('test')} disabled={busy !== null} className="btn">
          <IconPlay className="h-4 w-4" />
          {busy === 'test' ? 'Test en cours…' : 'Tester la connexion'}
        </button>
        <button onClick={() => run('import')} disabled={busy !== null} className="btn btn-primary">
          <IconImports className="h-4 w-4" />
          {busy === 'import' ? 'Planification…' : 'Lancer un import'}
        </button>
        <button onClick={() => run('import-vod')} disabled={busy !== null} className="btn" title="Importe uniquement les films & séries, sans toucher aux chaînes">
          <IconImports className="h-4 w-4" />
          {busy === 'import-vod' ? 'Planification…' : 'Films & séries uniquement'}
        </button>
        <button onClick={() => run('delete')} disabled={busy !== null} className="btn btn-danger">
          <IconTrash className="h-4 w-4" />
          {busy === 'delete' ? 'Suppression…' : 'Supprimer'}
        </button>
      </div>

      {feedback && (
        <p
          className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
            feedback.ok
              ? 'border-success/30 bg-success/10 text-success'
              : 'border-danger/30 bg-danger/10 text-danger'
          }`}
        >
          {feedback.ok ? <IconCheck className="h-4 w-4" /> : <IconX className="h-4 w-4" />}
          {feedback.message}
        </p>
      )}
    </div>
  );
}
