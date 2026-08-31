'use client';

import type { EpgEntry, Programme } from '@mbolo/contracts';
import { Icon } from '@mbolo/ui';
import { useRouter } from 'next/navigation';
import { buildWatchHref } from '../../live-tv/utils';

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

/**
 * Guide du jour en colonne (mobile) : une section par chaîne, les programmes
 * dans l'ordre chronologique, « en cours » surligné et passé estompé.
 * Plus lisible sur téléphone que la timeline horizontale du desktop.
 */
export function EpgDayList({
  entries,
  category,
  onSelectProgramme,
}: {
  entries: EpgEntry[];
  category?: string;
  onSelectProgramme: (channelName: string, programme: Programme) => void;
}) {
  const router = useRouter();
  const now = Date.now();

  return (
    <div className="flex flex-col gap-6">
      {entries.map((entry) => (
        <section key={entry.channel.id}>
          <button
            type="button"
            onClick={() => router.push(buildWatchHref(entry.channel.id, { category }))}
            className="flex w-full items-center gap-2.5 text-left"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-white/10 bg-white">
              {entry.channel.logoUrl ? (
                <img src={entry.channel.logoUrl} alt="" width={32} height={32} loading="lazy" decoding="async" className="h-full w-full object-contain p-0.5" />
              ) : (
                <span className="text-xs font-bold text-muted">{entry.channel.name.charAt(0)}</span>
              )}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm font-bold">{entry.channel.name}</span>
            <Icon.ChevronRight size={16} aria-hidden className="shrink-0 text-muted" />
          </button>

          <ul className="mt-2 divide-y divide-border/60 overflow-hidden rounded-xl border border-border bg-surface">
            {entry.programmes.map((programme) => {
              const start = new Date(programme.startsAt).getTime();
              const end = new Date(programme.endsAt).getTime();
              const live = start <= now && end > now;
              const past = end <= now;
              return (
                <li key={programme.id}>
                  <button
                    type="button"
                    onClick={() => onSelectProgramme(entry.channel.name, programme)}
                    className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition hover:bg-surface-2 ${past ? 'opacity-45' : ''}`}
                  >
                    <span className="w-12 shrink-0 text-xs font-bold tabular-nums text-muted">{formatTime(programme.startsAt)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-semibold">{programme.title}</span>
                      {live && (
                        <span className="mt-0.5 inline-flex items-center gap-1 rounded-full bg-danger px-1.5 py-0.5 text-[9px] font-bold tracking-widest text-white">
                          <span className="h-1 w-1 rounded-full bg-white" />
                          EN COURS
                        </span>
                      )}
                    </span>
                    <Icon.Bell size={15} aria-hidden className={`shrink-0 ${live ? 'text-accent' : 'text-faint'}`} />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
