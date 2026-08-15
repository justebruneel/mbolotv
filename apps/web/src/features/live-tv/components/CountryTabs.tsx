'use client';

import type { CountryOption } from '@mbolo/contracts';
import { Skeleton } from '@mbolo/ui';
import styles from './CategoryTabs.module.css';

export function CountryTabs({
  countries,
  active,
  onSelect,
  isLoading,
}: {
  countries: CountryOption[];
  active?: string;
  onSelect: (slug?: string) => void;
  isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <div className={styles.tabs}>
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} width={110} height={36} className={styles.skeleton} />
        ))}
      </div>
    );
  }

  if (countries.length === 0) return null;

  return (
    <div className={styles.tabs}>
      <button
        type="button"
        className={[styles.tab, !active ? styles.active : ''].filter(Boolean).join(' ')}
        onClick={() => onSelect(undefined)}
      >
        Tous les pays
      </button>
      {countries.map((country) => (
        <button
          key={country.slug}
          type="button"
          className={[styles.tab, active === country.slug ? styles.active : ''].filter(Boolean).join(' ')}
          onClick={() => onSelect(country.slug)}
        >
          {country.name}
          <span className={styles.count}>{country.count}</span>
        </button>
      ))}
    </div>
  );
}
