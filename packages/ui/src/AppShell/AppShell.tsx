'use client';

import { Fragment, ReactNode, useEffect, useState } from 'react';
import Link from 'next/link';
import { MoreVertical, Download } from 'lucide-react';
import styles from './AppShell.module.css';

export interface NavItem { href: string; label: string; icon?: ReactNode; }
export interface MenuSection { label: string; items: NavItem[]; }
export interface AppShellProps {
  brand: ReactNode;
  navItems: NavItem[];
  /** Sections du menu ⋮ / « Plus » — liens internes à l'app (navigation SPA). */
  menuSections?: MenuSection[];
  activeHref?: string;
  pathname?: string;
  activeUsers?: number;
  children: ReactNode;
  /** Slot rendu au centre des barres (recherche Netflix). */
  searchSlot?: ReactNode;
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: string }>;
}

// Deux barres de navigation INDÉPENDANTES, chacune masquée hors de son
// breakpoint par le CSS — aucun héritage ni partage de structure :
//   .desktopBar : ≥ 768 px   → logo · liens inline · badge · ⋮
//   .mobileBar  : < 768 px   → logo + « Mbolo TV » · badge · ⋮
//   .bottomTabs : < 768 px   → onglets bas (3 premiers navItems) + « Plus »
// Le menu ⋮ / Plus partagé ne contient QUE des liens internes (menuSections)
// + l'invite d'installation : la navigation principale a déjà ses onglets.
export function AppShell({ brand, navItems, menuSections = [], activeHref, pathname: _pathname, activeUsers, children, searchSlot }: AppShellProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => setMenuOpen(false), [_pathname]);
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
      {/* ================= BARRE DESKTOP (≥ 768 px) ================= */}
      <header className={styles.desktopBar}>
        <span className={styles.brand}>{brand}</span>

        <nav className={styles.desktopNav} aria-label="Navigation principale">
          {navItems.map((item) => {
            const active = item.href === activeHref;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={[styles.desktopLink, active ? styles.desktopLinkActive : ''].filter(Boolean).join(' ')}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        {searchSlot && <div className={[styles.searchSlot, styles.searchSlotDesktop].join(" ")}>{searchSlot}</div>}

        <div className={styles.barRight}>
          {usersBadge}
          <button
            type="button"
            className={[styles.iconButton, styles.desktopOnly].join(' ')}
            aria-label="Plus d'options"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((value) => !value)}
          >
            <MoreVertical size={20} aria-hidden />
          </button>
        </div>
      </header>

      {/* ================= BARRE MOBILE (< 768 px) ================= */}
      <header className={styles.mobileBar}>
        <div className={styles.mobileBarRow}>
          <span className={styles.mobileBrand}>{brand}</span>

          <div className={styles.barRight}>
            {usersBadge}
          </div>

          {searchSlot && <div className={styles.searchSlot}>{searchSlot}</div>}
        </div>
      </header>

      {/* Menu ⋮ / Plus : sections internes à l'app (navigation SPA, pas de
          nouvel onglet) + invite d'installation conditionnelle. */}
      {menuOpen && (
        <>
          <div className={styles.menuBackdrop} onClick={() => setMenuOpen(false)} aria-hidden="true" />
          <div className={styles.menuPanel} role="menu">
            {menuSections.map((section) => (
              <Fragment key={section.label}>
                <p className={styles.menuSection}>{section.label}</p>
                {section.items.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    role="menuitem"
                    className={[styles.menuItem, item.href === activeHref ? styles.menuItemActive : ''].filter(Boolean).join(' ')}
                    onClick={() => setMenuOpen(false)}
                  >
                    {item.icon}
                    {item.label}
                  </Link>
                ))}
              </Fragment>
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

      <main className={styles.main}>{children}</main>

      {/* Onglets bas mobiles : les 3 premiers navItems + « Plus » */}
      <nav className={styles.bottomTabs} aria-label="Navigation mobile">
        {navItems.slice(0, 3).map((item) => {
          const active = item.href === activeHref;
          return (
            <Link
              key={`tab-${item.href}`}
              href={item.href}
              className={[styles.bottomTab, active ? styles.bottomTabActive : ''].filter(Boolean).join(' ')}
            >
              {item.icon}
              <span>{item.label}</span>
            </Link>
          );
        })}
        <button
          type="button"
          className={[styles.bottomTab, menuOpen ? styles.bottomTabActive : ''].filter(Boolean).join(' ')}
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
