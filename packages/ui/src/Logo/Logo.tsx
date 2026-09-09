import styles from './Logo.module.css';

/**
 * Marque seule — variante sombre : tuile navy (#101823) + play en accent.
 * L'app est exclusivement sombre : le logo suit (tout sombre sauf le play
 * qui garde sa couleur d'origine, le teal de la marque).
 */
export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="1" y="1" width="22" height="22" rx="5" fill="#101823" />
      <path d="M9 7.5v9l7.5-4.5L9 7.5Z" fill="var(--mbolo-accent, #8ee8cf)" />
    </svg>
  );
}

export function Logo({ size = 28, stacked = false }: { size?: number; stacked?: boolean }) {
  if (stacked) {
    // Variante empilée : écran de lancement (logo + « Mbolo TV » en dessous,
    // comme le splash natif) — aucun spinner, le chargement se fait derrière.
    return (
      <span className={styles.logoStacked}>
        <LogoMark size={size} />
        <span className={styles.nameStacked}>Mbolo TV</span>
      </span>
    );
  }
  return (
    <span className={styles.logo}>
      <LogoMark size={size} />
      <span className={styles.name}>Mbolo TV</span>
    </span>
  );
}
