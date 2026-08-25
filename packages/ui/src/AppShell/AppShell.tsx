'use client';

import { ReactNode, useEffect, useState } from 'react';
import Link from 'next/link';
import { MoreVertical, Download } from 'lucide-react';
import styles from './AppShell.module.css';

export interface NavItem { href: string; label: string; icon?: ReactNode; }
export interface AppShellProps {
  brand: ReactNode;
  navItems: NavItem[];
  utilityItems?: NavItem[];
  sidebarActions?: ReactNode;
  activeHref?: string;
  pathname?: string;
  activeUsers?: number;
  children: ReactNode;
  /** 'overlay' : barre horizontale type Netflix (défaut). */
  variant?: 'sidebar' | 'overlay';
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: string }>;
}

export function AppShell({ brand, navItems, utilityItems = [], sidebarActions, activeHref, pathname, activeUsers, children, variant = 'overlay' }: AppShellProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => setMenuOpen(false), [pathname]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);
  useEffect(() => {
    const handler = (event: Event): void => { event.preventDefault(); setInstallEvent(event as BeforeInstallPromptEvent); };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const install = async (): Promise<void> => {
    if (!installEvent) return;
    await installEvent.prompt();
    await installEvent.userChoice;
    setInstallEvent(null);
  };

  const usersBadge = activeUsers != null && activeUsers > 0 ? (
    <span className={styles.activeBadge} title="Spectateurs actifs">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
      <span>{activeUsers}</span>
    </span>
  ) : null;

  return (
    <div className={styles.shell}>
      <header className={styles.topbar}>
        <span className={styles.topbarBrand}>{brand}</span>

        {/* Liens principaux (desktop) */}
        <nav className={styles.topLinks} aria-label="Navigation principale">
          {navItems.map((item) => {
            const active = item.href === activeHref;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={[styles.topLink, active ? styles.topLinkActive : ''].filter(Boolean).join(' ')}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className={styles.topRight}>
          {usersBadge}
          {sidebarActions}
          <button
            type="button"
            className={styles.menuButton}
            aria-label="Plus d'options"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((value) => !value)}
          >
            <MoreVertical size={20} aria-hidden />
          </button>
        </div>

        {menuOpen && (
          <>
            <div className={styles.menuBackdrop} onClick={() => setMenuOpen(false)} aria-hidden="true" />
            <div className={styles.menuPanel} role="menu">
              <p className={styles.menuSection}>Navigation</p>
              {navItems.map((item) => (
                <Link key={`n-${item.href}`} href={item.href} role="menuitem" className={styles.menuItem} onClick={() => setMenuOpen(false)}>
                  {item.icon}
                  {item.label}
                </Link>
              ))}
              <p className={styles.menuSection}>Plus</p>
              {utilityItems.map((item) => (
                <a key={`u-${item.href}`} href={item.href} role="menuitem" className={styles.menuItem} target="_blank" rel="noreferrer" onClick={() => setMenuOpen(false)}>
                  {item.icon}
                  {item.label}
                </a>
              ))}
              {installEvent && (
                <button type="button" role="menuitem" className={styles.menuItem} onClick={() => { void install(); setMenuOpen(false); }}>
                  <Download size={17} aria-hidden />
                  Installer l’application
                </button>
              )}
            </div>
          </>
        )}
      </header>

      <main className={styles.main}>{children}</main>

      {/* Onglets bas — signature Netflix mobile (< 768 px) */}
      <nav className={styles.bottomTabs} aria-label="Navigation mobile">
        {navItems.slice(0, 2).map((item) => {
          const active = item.href === activeHref;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={[styles.bottomTab, active ? styles.bottomTabActive : ""].filter(Boolean).join(" ")}
            >
              {item.icon}
              <span>{item.label}</span>
            </Link>
          );
        })}
        <button
          type="button"
          className={[styles.bottomTab, menuOpen ? styles.bottomTabActive : ""].filter(Boolean).join(" ")}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((value) => !value)}
        >
          <MoreVertical size={20} aria-hidden />
          <span>Plus</span>
        </button>
      </nav>
    </div>
  );
}
