import type { Metadata } from 'next';
import { OwnerLoginForm } from '../../../features/auth/components/owner-login-form';

export const metadata: Metadata = {
  title: 'Connexion — Mbolo TV Control',
};

export default function OwnerLoginPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-6">
      <div className="text-center">
        <h1 className="text-2xl font-bold">Mbolo TV Control</h1>
        <p className="mt-1 text-sm text-muted">Espace propriétaire sécurisé</p>
      </div>
      <OwnerLoginForm />
    </main>
  );
}