import type { ReactNode } from 'react';
import { ControlShell } from '../../../features/owner/components/control-shell';

export default function ControlLayout({ children }: { children: ReactNode }) {
  return <ControlShell>{children}</ControlShell>;
}
