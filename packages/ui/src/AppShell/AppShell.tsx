import { ReactNode } from 'react';
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
  children: ReactNode;
}

export function AppShell({ brand, navItems, activeHref, children }: AppShellProps) {
  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        {brand}
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
