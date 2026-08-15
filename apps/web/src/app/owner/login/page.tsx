import type { Metadata } from 'next';
import { Logo } from '@mbolo/ui';
import { OwnerLoginForm } from '../../../features/auth/components/owner-login-form';
import { IconAudit } from '../../../features/owner/components/ui/icons';

export const metadata: Metadata = {
  title: 'Connexion — Mbolo TV Control',
};

export default function OwnerLoginPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-6">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <Logo size={40} />
          <div>
            <h1 className="text-xl font-bold tracking-tight">Console propriétaire</h1>
            <p className="mt-1 text-sm text-muted">
              Espace sécurisé · double authentification requise
            </p>
          </div>
        </div>

        <div className="card p-6">
          <OwnerLoginForm />
        </div>

        <p className="flex items-center justify-center gap-1.5 text-center text-xs text-muted">
          <IconAudit className="h-3.5 w-3.5" />
          Toutes les connexions sont journalisées et auditées.
        </p>
      </div>
    </main>
  );
}
