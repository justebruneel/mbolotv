'use client';

import { Icon } from '@mbolo/ui';
import { useTheme } from './ThemeProvider';

// Bouton compact icône-seule : le libellé complet est dans le tooltip.
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  const cycle = () => {
    if (theme === 'dark') setTheme('light');
    else if (theme === 'light') setTheme('system');
    else setTheme('dark');
  };

  const label = theme === 'dark' ? 'Sombre' : theme === 'light' ? 'Clair' : 'Système';
  const IconComponent = theme === 'dark' ? Icon.Moon : theme === 'light' ? Icon.Sun : Icon.Monitor;

  return (
    <button
      type="button"
      onClick={cycle}
      title={`Thème : ${label}`}
      aria-label={`Thème actuel : ${label}. Cliquer pour changer.`}
      className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-[var(--mbolo-text-muted)] hover:bg-[var(--mbolo-surface-2)] hover:text-[var(--mbolo-text)] transition-colors"
    >
      <span className="flex w-5 items-center justify-center">
        <IconComponent size={18} />
      </span>
    </button>
  );
}
