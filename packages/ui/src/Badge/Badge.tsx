import { HTMLAttributes } from 'react';
import styles from './Badge.module.css';

export type BadgeTone = 'default' | 'success' | 'danger' | 'warning' | 'accent';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  live?: boolean;
}

export function Badge({ tone = 'default', live = false, className, children, ...rest }: BadgeProps) {
  const classes = [styles.badge, styles[tone], className].filter(Boolean).join(' ');
  return (
    <span className={classes} {...rest}>
      {live && <span className={[styles.dot, styles.pulse].join(' ')} />}
      {children}
    </span>
  );
}
