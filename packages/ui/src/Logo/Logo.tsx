import styles from './Logo.module.css';

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <span className={styles.logo}>
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
        <rect x="1" y="1" width="22" height="22" rx="5" fill="var(--mbolo-primary)" />
        <path d="M9 7.5v9l7.5-4.5L9 7.5Z" fill="#fff" />
      </svg>
      <span className={styles.name}>Mbolo TV</span>
    </span>
  );
}
