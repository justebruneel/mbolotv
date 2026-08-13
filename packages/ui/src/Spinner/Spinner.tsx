import styles from './Spinner.module.css';

export interface SpinnerProps {
  size?: 'default' | 'small';
}

export function Spinner({ size = 'default' }: SpinnerProps) {
  return <span className={[styles.spinner, styles[size]].join(' ')} aria-label="Chargement" role="status" />;
}
