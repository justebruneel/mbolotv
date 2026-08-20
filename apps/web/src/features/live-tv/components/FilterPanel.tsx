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
      'px-3.5 py-1.5 rounded-xl text-xs font-semibold border transition-all duration-200',
      isActive
        ? 'bg-accent/15 border-accent/50 text-accent shadow-sm shadow-accent/10'
        : 'bg-surface-2 border-border text-muted hover:border-accent/30 hover:text-foreground',
    ].join(' ');

  return (
    <div className="px-4 py-5 bg-surface/80 border-b border-border space-y-4 animate-slide-down">
      {countries.length > 0 && (
        <div>
          <p className="text-[10.5px] uppercase tracking-widest text-faint font-bold mb-2.5">Pays</p>
          <div className="flex flex-wrap gap-2">
            {countries.map((country) => (
              <button
                key={country.slug}
                type="button"
                className={chip(selectedCountry === country.slug)}
                onClick={() => onCountry(country.slug)}
              >
                {country.name} <span className="opacity-50">· {country.count}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {bouquets.length > 0 && (
        <div>
          <p className="text-[10.5px] uppercase tracking-widest text-faint font-bold mb-2.5">Bouquets</p>
          <div className="flex flex-wrap gap-2">
            {bouquets.map((bouquet) => (
              <button
                key={bouquet.id}
                type="button"
                className={chip(selectedBouquet === bouquet.slug)}
                onClick={() => onBouquet(bouquet.slug)}
              >
                {formatCategoryName(bouquet.name)} <span className="opacity-50">· {bouquet.channelCount ?? ''}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
