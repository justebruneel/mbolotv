'use client';

import type { Category } from '@mbolo/contracts';
import { Skeleton } from '@mbolo/ui';
import styles from './CategoryTabs.module.css';

export function CategoryTabs({
  categories,
  active,
  onSelect,
  isLoading,
}: {
  categories: Category[];
  active?: string;
  onSelect: (slug?: string) => void;
  isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <div className={styles.tabs}>
        {Array.from({ length: 5 }).map((_, index) => (
          <Skeleton key={index} width={110} height={36} className={styles.skeleton} />
        ))}
      </div>
    );
  }

  return (
    <div className={styles.tabs}>
      <button
        type="button"
        className={[styles.tab, !active ? styles.active : ''].filter(Boolean).join(' ')}
        onClick={() => onSelect(undefined)}
      >
        Toutes
      </button>
      {categories.map((category) => (
        <button
          key={category.id}
          type="button"
          className={[styles.tab, active === category.slug ? styles.active : ''].filter(Boolean).join(' ')}
          onClick={() => onSelect(category.slug)}
        >
          {category.name}
          <span className={styles.count}>{category.channelCount ?? ''}</span>
        </button>
      ))}
    </div>
  );
}
