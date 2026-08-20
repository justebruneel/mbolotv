import type { ReactNode } from 'react';

type Tone = 'default' | 'accent' | 'success' | 'warning' | 'danger';

const TONE_STYLES: Record<Tone, string> = {
  default: 'text-muted',
  accent: 'text-accent',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
};

const TONE_BG: Record<Tone, string> = {
  default: 'bg-border/50',
  accent: 'bg-accent-muted',
  success: 'bg-success-muted',
  warning: 'bg-warning-muted',
  danger: 'bg-danger-muted',
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
    <div className="group relative overflow-hidden rounded-2xl border border-border bg-surface p-5 shadow-sm transition-all duration-300 hover:border-accent/30 hover:shadow-md hover:-translate-y-0.5">
      {/* Accent glow on hover */}
      <div className="absolute inset-0 bg-gradient-to-br from-accent/5 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />

      <div className="relative flex items-center justify-between gap-3">
        {icon ? (
          <span className={`flex h-10 w-10 items-center justify-center rounded-xl ${TONE_BG[tone]} ${TONE_STYLES[tone]}`}>
            {icon}
          </span>
        ) : (
          <span />
        )}
        <span className="font-mono text-3xl font-extrabold tabular-nums tracking-tight">
          {value}
        </span>
      </div>

      <p className="relative mt-3 text-sm font-semibold text-secondary">{label}</p>
      {sub && <p className="relative mt-0.5 text-xs text-faint">{sub}</p>}
    </div>
  );
}
