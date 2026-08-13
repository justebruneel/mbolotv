import { ReactNode } from 'react';
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
        📺
      </div>
      <strong>{title}</strong>
      {hint && <p style={{ margin: 0 }}>{hint}</p>}
      {action}
    </div>
  );
}
