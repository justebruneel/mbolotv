import type { ReactNode } from 'react';

export function Card({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-2xl border border-border bg-surface shadow-sm transition-all duration-200 hover:shadow-md ${className}`}>
      {children}
    </div>
  );
}

export function CardHeader({
  icon,
  title,
  description,
  actions,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-4">
      <div className="flex items-start gap-3">
        {icon && (
          <span className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-lg bg-surface-2 text-muted">
            {icon}
          </span>
        )}
        <div>
          <h2 className="text-sm font-bold tracking-tight">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function CardBody({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`px-6 py-5 ${className}`}>{children}</div>;
}
