import type { ReactNode } from 'react';

type Tone = 'default' | 'accent' | 'success' | 'warning' | 'danger';

const TONE_STYLES: Record<Tone, string> = {
  default: 'text-muted',
  accent: 'text-accent',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
};

const TONE_BAR: Record<Tone, string> = {
  default: 'bg-border',
  accent: 'bg-accent',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
};

export function StatCard({
  icon,
  label,
  value,
  sub,
  tone = 'default',
}: {
  icon?: ReactNode;
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: Tone;
}) {
  return (
    <div className="card card-interactive relative overflow-hidden p-5">
      <span className={`absolute inset-y-0 left-0 w-0.5 ${TONE_BAR[tone]}`} aria-hidden />
      <div className="flex items-center justify-between gap-3">
        {icon ? <span className={`${TONE_STYLES[tone]}`}>{icon}</span> : <span />}
        <span className="font-mono text-2xl font-semibold tabular-nums tracking-tight">{value}</span>
      </div>
      <p className="mt-3 text-sm font-medium text-muted">{label}</p>
      {sub && <p className="mt-0.5 text-xs text-muted/70">{sub}</p>}
    </div>
  );
}
