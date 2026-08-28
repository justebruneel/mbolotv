'use client';

import { Icon } from '@mbolo/ui';
import { useTheme } from './ThemeProvider';

// Ligne de menu pleine largeur (utilisée dans « Plus d'options ») : l'icône
// reflète le thème courant, le clic fait tourner Sombre → Clair → Système.
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
      className="flex w-full items-center gap-3 text-left"
    >
      <span className="flex w-[18px] items-center justify-center">
        <IconComponent size={18} />
      </span>
      <span>Thème : {label}</span>
    </button>
  );
}
