'use client';

import styles from './FavoriteButton.module.css';

export interface FavoriteButtonProps {
  isActive: boolean;
  onToggle: () => void;
  label?: string;
}

export function FavoriteButton({ isActive, onToggle, label }: FavoriteButtonProps) {
  return (
    <button
      type="button"
      className={[styles.fav, isActive ? styles.active : ''].filter(Boolean).join(' ')}
      onClick={onToggle}
      aria-pressed={isActive}
      aria-label={label ?? (isActive ? 'Retirer des favoris' : 'Ajouter aux favoris')}
    >
      {isActive ? '♥' : '♡'}
    </button>
  );
}
