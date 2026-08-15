'use client';

import type { Category, CountryOption } from '@mbolo/contracts';
import { formatCategoryName } from '../utils';

export function FilterPanel({
  countries,
  bouquets,
  selectedCountry,
  selectedBouquet,
  onCountry,
  onBouquet,
}: {
  countries: CountryOption[];
  bouquets: Category[];
  selectedCountry?: string;
  selectedBouquet?: string;
  onCountry: (slug: string) => void;
  onBouquet: (slug: string) => void;
}) {
  const chip = (isActive: boolean): string =>
    [
      'px-3 py-1 rounded-full text-xs font-medium border transition-colors',
      isActive
        ? 'bg-accent border-accent text-on-accent'
        : 'bg-surface-2 border-border text-muted hover:border-accent/60',
    ].join(' ');

  return (
    <div className="px-4 py-4 bg-surface-2/60 border-b border-border space-y-4">
      {countries.length > 0 && (
        <div>
          <p className="text-xs uppercase tracking-wider text-muted font-medium mb-2">Pays</p>
          <div className="flex flex-wrap gap-2">
            {countries.map((country) => (
              <button
                key={country.slug}
                type="button"
                className={chip(selectedCountry === country.slug)}
                onClick={() => onCountry(country.slug)}
              >
                {country.name} <span className="opacity-60">· {country.count}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {bouquets.length > 0 && (
        <div>
          <p className="text-xs uppercase tracking-wider text-muted font-medium mb-2">Bouquets</p>
          <div className="flex flex-wrap gap-2">
            {bouquets.map((bouquet) => (
              <button
                key={bouquet.id}
                type="button"
                className={chip(selectedBouquet === bouquet.slug)}
                onClick={() => onBouquet(bouquet.slug)}
              >
                {formatCategoryName(bouquet.name)} <span className="opacity-60">· {bouquet.channelCount ?? ''}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
