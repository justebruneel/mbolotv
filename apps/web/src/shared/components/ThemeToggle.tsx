'use client';

import { Icon } from '@mbolo/ui';
import { useTheme } from './ThemeProvider';

const THEME_LABELS = { dark: 'Sombre', light: 'Clair', system: 'Système' } as const;

// Deux variantes :
//  - "menu" (défaut) : ligne de menu pleine largeur (« Plus d'options » de
//    l'app) — icône + libellé du thème courant.
//  - "icon" : pill icône seule pour les navbars (accueil) — le libellé reste
//    accessible via title/aria-label.
export function ThemeToggle({ variant = 'menu' }: { variant?: 'menu' | 'icon' }) {
  const { theme, setTheme } = useTheme();

  const cycle = () => {
    if (theme === 'dark') setTheme('light');
    else if (theme === 'light') setTheme('system');
    else setTheme('dark');
  };

  const label = THEME_LABELS[theme];
  const IconComponent = theme === 'dark' ? Icon.Moon : theme === 'light' ? Icon.Sun : Icon.Monitor;

  if (variant === 'icon') {
    return (
      <button
        type="button"
        onClick={cycle}
        title={`Thème : ${label}`}
        aria-label={`Thème actuel : ${label}. Cliquer pour changer.`}
        className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-border bg-surface/70 backdrop-blur text-foreground hover:bg-surface transition"
      >
        <IconComponent size={16} aria-hidden />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={cycle}
      title={`Thème : ${label}`}
      aria-label={`Thème actuel : ${label}. Cliquer pour changer.`}
      className="flex w-full items-center gap-3 text-left"
    >
      <span className="flex w-[18px] items-center justify-center">
        <IconComponent size={18} />
      </span>
      <span>Thème : {label}</span>
    </button>
  );
}
