import type { ReactNode } from 'react';
import { AppShell, Logo } from '@mbolo/ui';
import { getVerifiedOwnerSession } from '../../../features/auth/server/owner-session';

const OWNER_NAV = [
  { href: '/control', label: 'Vue d’ensemble', icon: '📊' },
  { href: '/control/sources', label: 'Sources', icon: '🔌' },
  { href: '/control/imports', label: 'Imports', icon: '⬇️' },
  { href: '/control/audit', label: 'Audit', icon: '🛡️' },
];

export default async function ControlLayout({ children }: { children: ReactNode }) {
  await getVerifiedOwnerSession();
  return (
    <AppShell brand={<Logo />} navItems={OWNER_NAV} activeHref="/control">
      {children}
    </AppShell>
  );
}