'use client';

import type { AccessStatus } from '@mbolo/contracts';
import { Logo } from '@mbolo/ui';
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
        <span className="inline-flex items-center gap-2 rounded-full border border-accent/30 bg-accent/10 px-4 py-1.5 text-xs font-bold tracking-wide text-accent backdrop-blur-sm animate-slide-up">
          IPTV MULTI-SOURCES
        </span>

        <h1 className="mt-6 text-4xl font-extrabold tracking-tight animate-slide-up stagger-1 sm:text-5xl">
          Regardez le direct,
          <br />
          <span className="bg-gradient-to-r from-accent via-accent-hover to-accent bg-clip-text text-transparent">
            sans limites.
          </span>
        </h1>

        <p className="mt-4 max-w-md text-base leading-relaxed text-secondary animate-slide-up stagger-2">
          Vos chaînes préférées en streaming adaptatif, sur tous vos appareils.
        </p>

        <div className="mt-8 w-full animate-scale-in stagger-3 flex justify-center">
          <AccessForm onRedeemed={handleRedeemed} />
        </div>

        <ul className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs text-muted animate-fade-in stagger-4">
          <li>🔐 Un code = un appareil</li>
          <li>📺 Téléphone, tablette & TV</li>
          <li>⏱ Codes 7, 14 ou 30 jours</li>
        </ul>
      </div>

      <footer className="relative z-10 px-6 pb-6 text-center text-xs text-faint animate-fade-in stagger-5">
        Streaming adaptatif · Multi-sources · PWA installable
      </footer>
    </main>
  );
}
