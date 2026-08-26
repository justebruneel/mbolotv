'use client';

import type { AccessStatus } from '@mbolo/contracts';
import { Icon, Logo } from '@mbolo/ui';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AccessChecking, AccessForm, useAccessStatus } from '../features/auth/components/access';
import { ThemeToggle } from '../shared/components/ThemeToggle';

/**
 * Portail d'entrée de l'application (style Netflix) :
 *  - vérification de l'accès au démarrage ;
 *  - appareil déjà autorisé → ouverture directe de /live ;
 *  - sinon → page épurée avec le formulaire du code d'accès.
 */
export default function EntryPage() {
  const router = useRouter();
  const { status, loading } = useAccessStatus();
  const [granted, setGranted] = useState(false);

  const active = granted || Boolean(status?.active);
  useEffect(() => {
    if (active) router.replace('/live');
  }, [active, router]);

  function handleRedeemed(next: AccessStatus): void {
    if (next.active) setGranted(true);
  }

  // Vérification en cours, ou bascule vers /live : écran de marque.
  if (loading || active) {
    return <AccessChecking label={active ? 'Accès validé — ouverture du direct…' : 'Vérification de votre accès…'} />;
  }

  return (
    <main className="relative flex min-h-dvh flex-col overflow-hidden">
      {/* Halos décoratifs */}
      <div aria-hidden className="pointer-events-none absolute -left-32 -top-40 h-96 w-96 rounded-full bg-accent/15 blur-[120px]" />
      <div aria-hidden className="pointer-events-none absolute -bottom-48 -right-24 h-96 w-96 rounded-full bg-accent/10 blur-[120px]" />

      <header className="relative z-10 flex items-center justify-between px-5 py-5 sm:px-8">
        <Logo />
        <ThemeToggle />
      </header>

      <div className="relative z-10 mx-auto flex w-full max-w-xl flex-1 flex-col items-center justify-center px-5 py-10 text-center animate-fade-in">
        <h1 className="text-4xl font-extrabold tracking-tight animate-slide-up sm:text-5xl">
          Regardez le direct,
          <br />
          <span className="bg-gradient-to-r from-accent via-accent-hover to-accent bg-clip-text text-transparent">
            sans limites.
          </span>
        </h1>

        <p className="mt-4 max-w-md text-base leading-relaxed text-secondary animate-slide-up stagger-1">
          Vos chaînes préférées en streaming adaptatif, sur tous vos appareils.
        </p>

        <div className="mt-8 w-full animate-scale-in stagger-2 flex justify-center">
          <AccessForm onRedeemed={handleRedeemed} />
        </div>

        <ul className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs font-medium text-muted animate-fade-in stagger-3">
          <li className="inline-flex items-center gap-1.5">
            <Icon.ShieldCheck size={15} aria-hidden className="text-accent" /> Un code = un appareil
          </li>
          <li className="inline-flex items-center gap-1.5">
            <Icon.Tv size={15} aria-hidden className="text-accent" /> Téléphone, tablette &amp; TV
          </li>
          <li className="inline-flex items-center gap-1.5">
            <Icon.Clock size={15} aria-hidden className="text-accent" /> Codes 7, 14 ou 30 jours
          </li>
        </ul>
      </div>

      <footer className="relative z-10 space-y-1 px-6 pb-6 text-center animate-fade-in stagger-4">
        <p className="text-xs text-faint">Streaming adaptatif · Multi-sources · PWA installable</p>
        <p className="text-xs font-semibold text-muted">
          © {new Date().getFullYear()} Groupe Nzogho — Tous droits réservés.
        </p>
      </footer>
    </main>
  );
}
