import type { ReactNode } from 'react';
import { Icon } from '@mbolo/ui';

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h1 className="text-xl font-bold tracking-tight sm:text-2xl">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <a href={href} className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-accent">
      <Icon.ChevronLeft size={15} aria-hidden />
      {label}
    </a>
  );
}