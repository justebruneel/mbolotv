'use client';

import { ReactNode, useEffect, useState } from 'react';
import Link from 'next/link';
import { ExternalLink, Menu, Download } from 'lucide-react';
import styles from './AppShell.module.css';

export interface NavItem { href: string; label: string; icon?: ReactNode; }
export interface AppShellProps { brand: ReactNode; navItems: NavItem[]; utilityItems?: NavItem[]; sidebarActions?: ReactNode; activeHref?: string; pathname?: string; activeUsers?: number; children: ReactNode; }

export function AppShell({ brand, navItems, utilityItems = [], sidebarActions, activeHref, pathname, activeUsers, children }: AppShellProps) {
  const [open, setOpen] = useState(false);
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && open) {
        setOpen(false);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);
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

  return (
    <div className={styles.shell}>
      <header className={styles.topbar}>
        <button type="button" className={styles.menuButton} onClick={() => setOpen(true)} aria-label="Ouvrir le menu" aria-expanded={open}>
          <Menu size={20} aria-hidden />
        </button>
        <span className={styles.topbarBrand}>{brand}</span>
        {activeUsers != null && activeUsers > 0 && (
          <span className={styles.activeBadge}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
            <span>{activeUsers}</span>
          </span>
        )}
      </header>

      <div
        className={[styles.overlay, open ? styles.overlayVisible : ''].filter(Boolean).join(' ')}
        onClick={() => setOpen(false)}
        aria-hidden="true"
      />

      <aside
        className={[styles.sidebar, open ? styles.sidebarOpen : ''].filter(Boolean).join(' ')}
        aria-label="Navigation principale"
        role={open ? 'dialog' : undefined}
        aria-modal={open ? true : undefined}
      >
        <div className={styles.brand}>
          {brand}
          {activeUsers != null && activeUsers > 0 && (
            <span className={styles.activeBadge}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
              <span>{activeUsers}</span>
            </span>
          )}
        </div>

        <nav className={styles.nav}>
          {navItems.map((item) => {
            const active = item.href === activeHref;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={[styles.item, active ? styles.active : ''].filter(Boolean).join(' ')}
                aria-current={active ? 'page' : undefined}
              >
                {item.icon && <span className={styles.icon}>{item.icon}</span>}
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className={styles.secondaryNav}>
          <p className={styles.sectionLabel}>Ressources</p>
          {utilityItems.map((item) => (
            <Link key={item.href} href={item.href} className={styles.item}>
              <span className={styles.icon}>{item.icon ?? <ExternalLink size={17} />}</span>
              <span>{item.label}</span>
            </Link>
          ))}
          {installEvent && (
            <button type="button" className={styles.installButton} onClick={() => void install()}>
              <Download size={16} /> Installer l'application
            </button>
          )}
        </div>

        {sidebarActions && <div className={styles.sidebarActions}>{sidebarActions}</div>}

        <div className={styles.sidebarFooter}>
          © {new Date().getFullYear()} Mbolo TV<br />
          <span>Créer par Groupe Nzogho</span>
        </div>
      </aside>

      <main id="main-content" className={styles.main} tabIndex={-1}>{children}</main>
    </div>
  );
}

declare global {
  interface BeforeInstallPromptEvent extends Event {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
  }
}
