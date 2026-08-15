'use client';

import { ReactNode, useEffect, useState } from 'react';
import { Menu } from 'lucide-react';
import styles from './AppShell.module.css';

export interface NavItem {
  href: string;
  label: string;
  icon?: ReactNode;
}

export interface AppShellProps {
  brand: ReactNode;
  navItems: NavItem[];
  activeHref?: string;
  pathname?: string;
  children: ReactNode;
}

export function AppShell({ brand, navItems, activeHref, pathname, children }: AppShellProps) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  return (
    <div className={styles.shell}>
      <header className={styles.topbar}>
        <button
          type="button"
          className={styles.menuButton}
          onClick={() => setOpen(true)}
          aria-label="Ouvrir le menu"
          aria-expanded={open}
        >
          <Menu size={20} aria-hidden />
        </button>
        <span className={styles.topbarBrand}>{brand}</span>
      </header>

      <div
        className={[styles.overlay, open ? styles.overlayVisible : ''].filter(Boolean).join(' ')}
        onClick={() => setOpen(false)}
        aria-hidden
      />

      <aside className={[styles.sidebar, open ? styles.sidebarOpen : ''].filter(Boolean).join(' ')}>
        <div className={styles.brand}>{brand}</div>
        <nav className={styles.nav}>
          {navItems.map((item) => {
            const active = item.href === activeHref;
            return (
              <a
                key={item.href}
                href={item.href}
                className={[styles.item, active ? styles.active : ''].filter(Boolean).join(' ')}
                aria-current={active ? 'page' : undefined}
              >
                {item.icon && <span className={styles.icon}>{item.icon}</span>}
                <span>{item.label}</span>
              </a>
            );
          })}
        </nav>
      </aside>

      <main className={styles.main}>{children}</main>
    </div>
  );
}