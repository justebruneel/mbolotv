import { ReactNode } from 'react';
import { Tv } from 'lucide-react';
import styles from './EmptyState.module.css';

export interface EmptyStateProps {
  title: string;
  hint?: string;
  action?: ReactNode;
}

export function EmptyState({ title, hint, action }: EmptyStateProps) {
  return (
    <div className={styles.empty}>
      <div className={styles.icon} aria-hidden>
        <Tv size={40} strokeWidth={1.6} />
      </div>
      <strong>{title}</strong>
      {hint && <p style={{ margin: 0 }}>{hint}</p>}
      {action}
    </div>
  );
}
