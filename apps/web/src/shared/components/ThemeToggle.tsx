'use client';

import { Icon } from '@mbolo/ui';
import { useTheme } from './ThemeProvider';

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
      className="flex items-center gap-2.5 w-full min-h-[40px] px-3 rounded-lg text-sm font-medium text-[var(--mbolo-text-muted)] hover:text-[var(--mbolo-text)] hover:bg-[var(--mbolo-surface-2)] transition-colors"
      aria-label={`Thème actuel : ${label}. Cliquer pour changer.`}
    >
      <span className="flex w-5 items-center justify-center">
        <IconComponent size={18} />
      </span>
      <span>Thème : {label}</span>
    </button>
  );
}
