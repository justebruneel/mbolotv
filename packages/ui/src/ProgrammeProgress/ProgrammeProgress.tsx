'use client';

import { useEffect, useState } from 'react';

function formatRemaining(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return minutes > 0 ? `${hours}h${minutes.toString().padStart(2, '0')}` : `${hours}h`;
  return `${minutes}m`;
}

export interface ProgrammeProgressProps {
  startsAt: string;
  endsAt: string;
  className?: string;
}

export function ProgrammeProgress({ startsAt, endsAt, className }: ProgrammeProgressProps) {
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const start = new Date(startsAt).getTime();
  const end = new Date(endsAt).getTime();
  const total = end - start;

  if (!Number.isFinite(total) || total <= 0) return null;

  const clamped = Math.max(0, Math.min(now - start, total));
  const progress = (clamped / total) * 100;
  const remaining = formatRemaining(end - now);
  const endLabel = new Date(end).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

  return (
    <div className={className}>
      <div
        className="h-1 w-full overflow-hidden rounded-full bg-white/15"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress)}
      >
        <div
          className="h-full rounded-full bg-danger transition-[width] duration-500 ease-linear"
          style={{ width: `${progress}%` }}
        />
      </div>
      <p className="mt-1 text-[10px] text-white/70">
        Fin à {endLabel} · reste {remaining}
      </p>
    </div>
  );
}
