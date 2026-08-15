import type { ReactNode } from 'react';
import { ControlShell } from '../../../features/owner/components/control-shell';
import { getVerifiedOwnerSession } from '../../../features/auth/server/owner-session';

export default async function ControlLayout({ children }: { children: ReactNode }) {
  await getVerifiedOwnerSession();
  return <ControlShell>{children}</ControlShell>;
}