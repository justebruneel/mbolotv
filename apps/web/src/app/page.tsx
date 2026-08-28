'use client';

import type { AccessStatus } from '@mbolo/contracts';
import { Icon, Logo } from '@mbolo/ui';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { AccessChecking, AccessExpiredBanner, AccessForm, useAccessStatus } from '../features/auth/components/access';
import { ThemeToggle } from '../shared/components/ThemeToggle';
import { apiGet } from '../shared/api/client';

/**
 * Portail d'entrée de l'application (style Netflix) :
 *  - vérification de l'accès au démarrage ;
 *  - appareil déjà autorisé → ouverture directe de /live ;
 *  - sinon → page marketing + formulaire du code d'accès.
 */

const WHATSAPP_BASE = 'https://wa.me/24160108984';

function scrollToId(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export default function EntryPage() {
  const router = useRouter();
  const { status, loading } = useAccessStatus();
  const [granted, setGranted] = useState(false);
  const [liveCount, setLiveCount] = useState<number | null>(null);

  // Compteur public sans QueryClient (évite prerender error sur Vercel)
  useEffect(() => {
    let cancelled = false;
    apiGet<{ global: number }>('/activity/counts')
      .then((res) => {
        if (!cancelled) setLiveCount(res.global);
      })
      .catch(() => {});
    const id = setInterval(() => {
      apiGet<{ global: number }>('/activity/counts')
        .then((res) => {
          if (!cancelled) setLiveCount(res.global);
        })
        .catch(() => {});
    }, 15_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const active = granted || Boolean(status?.active);
  useEffect(() => {
    if (active) router.replace('/live');
  }, [active, router]);

  function handleRedeemed(next: AccessStatus): void {
    if (next.active) setGranted(true);
  }

  const handleRenew = useCallback(() => {
    const input = document.querySelector<HTMLInputElement>('[data-testid="access-code-input"]');
    if (input) {
      input.focus();
      input.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else {
      scrollToId('acces');
    }
  }, []);

  // Vérification en cours, ou bascule vers /live : écran de marque.
  if (loading || active) {
    return <AccessChecking label={active ? 'Accès validé — ouverture du direct…' : 'Vérification de votre accès…'} />;
  }

  return (
    <main className="relative flex min-h-dvh flex-col overflow-hidden bg-bg">
      {/* ===== BACKDROP — halos + gradients (épuré, sans mosaïque) ===== */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute inset-0 bg-bg" />
        <div className="absolute -left-32 -top-40 h-[560px] w-[560px] rounded-full bg-accent/12 blur-[120px]" />
        <div className="absolute -bottom-48 -right-24 h-[560px] w-[560px] rounded-full bg-accent/10 blur-[120px]" />
        <div className="absolute inset-0 bg-gradient-to-b from-bg via-bg/70 to-bg" />
        <div className="absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-bg to-transparent" />
      </div>

      <header className="relative z-10 flex items-center justify-between px-5 py-5 sm:px-8">
        <Logo />
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => scrollToId('telechargement')}
            className="inline-flex items-center gap-1.5 rounded-full bg-accent px-3.5 py-1.5 text-xs font-bold text-on-accent shadow transition hover:bg-accent-hover"
          >
            <Icon.Download size={14} aria-hidden /> Télécharger
          </button>
          <a
            href={WHATSAPP_BASE}
            target="_blank"
            rel="noreferrer"
            className="hidden sm:inline-flex items-center gap-1.5 rounded-full border border-border bg-surface/70 px-3 py-1.5 text-xs font-semibold backdrop-blur hover:bg-surface transition"
          >
            <Icon.Mail size={14} aria-hidden className="text-accent" /> Besoin d’un code ?
          </a>
          <ThemeToggle />
        </div>
      </header>

      {/* ===== HERO ===== */}
      <section className="relative z-10 mx-auto flex w-full max-w-5xl flex-col items-center px-5 py-10 text-center md:py-16">
        <h1 className="mt-4 max-w-4xl text-4xl font-black tracking-tight animate-slide-up sm:text-5xl md:text-[56px] md:leading-[0.95]">
          Regardez le direct,
          <br />
          <span className="bg-gradient-to-r from-accent via-accent-hover to-accent bg-clip-text text-transparent">sans limites.</span>
        </h1>
        <p className="mt-4 max-w-2xl text-base leading-relaxed text-secondary animate-slide-up stagger-1 md:text-lg">
          Vos chaînes préférées en streaming adaptatif, sur tous vos appareils. <span className="font-semibold text-foreground">Un code = un appareil</span> · Qualité auto · PWA installable.
        </p>

        <div className="mt-8 flex flex-col items-center gap-3 animate-scale-in stagger-2 sm:flex-row">
          <button
            type="button"
            onClick={() => scrollToId('acces')}
            className="group relative inline-flex items-center gap-2 overflow-hidden rounded-xl bg-accent px-8 py-4 text-sm font-black uppercase tracking-wide text-on-accent shadow-glow transition hover:bg-accent-hover"
          >
            <span className="relative z-10 inline-flex items-center gap-2">
              <Icon.Play size={16} aria-hidden /> Activer mon accès
            </span>
            <span aria-hidden className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/20 to-transparent group-hover:animate-shimmer" />
          </button>
          <button
            type="button"
            onClick={() => scrollToId('offres')}
            className="inline-flex items-center gap-2 rounded-xl border border-border bg-surface/70 px-7 py-4 text-sm font-bold backdrop-blur hover:bg-surface transition"
          >
            <Icon.Layers size={16} aria-hidden className="text-accent" /> Voir les offres 7 / 14 / 30 jours
          </button>
        </div>

        <p className="mt-3 text-xs text-muted animate-fade-in stagger-3">
          Paiement via WhatsApp · Activation en 2 min · Support 7j/7
        </p>

        {/* Mini trust sous hero */}
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3 animate-fade-in stagger-3">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-surface border border-border px-3 py-1.5 text-xs font-semibold">
            <Icon.ShieldCheck size={14} aria-hidden className="text-success" /> Sources chiffrées
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-surface border border-border px-3 py-1.5 text-xs font-semibold">
            <Icon.Tv size={14} aria-hidden className="text-accent" /> Télé · Phone · Tablette
          </span>
          {liveCount != null && liveCount > 0 && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-danger-muted border border-danger/20 px-3 py-1.5 text-xs font-bold text-danger">
              <span className="h-2 w-2 animate-pulse rounded-full bg-danger" /> {liveCount} en direct
            </span>
          )}
        </div>
      </section>

      {/* ===== BARRE PREUVE SOCIALE ===== */}
      <section className="relative z-10 border-y border-border bg-surface/70 backdrop-blur supports-[backdrop-filter]:bg-surface/60">
        <div className="mx-auto grid max-w-5xl grid-cols-2 gap-0 divide-x divide-border sm:grid-cols-4">
          {[
            { value: '2 000+', label: 'Chaînes', icon: Icon.Tv },
            { value: '4', label: 'Pays & régions', icon: Icon.Layers },
            { value: '99,2%', label: 'Disponibilité', icon: Icon.Activity },
            { value: 'PWA', label: 'Installable', icon: Icon.Download },
          ].map((item) => (
            <div key={item.label} className="flex flex-col items-center gap-1 px-4 py-5 text-center">
              <item.icon size={18} aria-hidden className="text-accent" />
              <span className="text-lg font-black leading-none">{item.value}</span>
              <span className="text-xs font-semibold uppercase tracking-wide text-muted">{item.label}</span>
            </div>
          ))}
        </div>
      </section>

      {/* ===== FORMULAIRE + BANNER EXPIRATION ===== */}
      <section id="acces" className="relative z-10 mx-auto flex w-full max-w-5xl flex-col items-center px-5 py-10 md:py-14 scroll-mt-8">
        <div className="w-full max-w-md flex flex-col items-center">
          {status && !status.active && status.expiresAt && (
            <div className="w-full">
              <AccessExpiredBanner status={status} onRenew={handleRenew} />
            </div>
          )}
          <AccessForm onRedeemed={handleRedeemed} />
          <ul className="mt-6 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs font-medium text-muted">
            <li className="inline-flex items-center gap-1.5">
              <Icon.ShieldCheck size={15} aria-hidden className="text-accent" /> Un code = un appareil
            </li>
            <li className="inline-flex items-center gap-1.5">
              <Icon.Clock size={15} aria-hidden className="text-accent" /> 7, 14 ou 30 jours
            </li>
            <li className="inline-flex items-center gap-1.5">
              <Icon.RefreshCw size={15} aria-hidden className="text-accent" /> Promo 24h disponible
            </li>
          </ul>
        </div>
      </section>

      {/* ===== PRICING 7/14/30 + PROMO ===== */}
      <section id="offres" className="relative z-10 mx-auto w-full max-w-5xl px-5 py-10 scroll-mt-8">
        <div className="text-center">
          <p className="text-xs font-bold uppercase tracking-widest text-accent">Tarifs transparents</p>
          <h2 className="mt-2 text-2xl font-black tracking-tight md:text-3xl">Choisissez votre durée</h2>
          <p className="mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-muted">
            Paiement sécurisé sur WhatsApp. Vous recevez votre code en 2 minutes, valable immédiatement sur 1 appareil.
          </p>
        </div>

        <div className="mt-8 grid gap-4 md:grid-cols-3">
          {[
            { days: 7, price: '3 500', perDay: '500', popular: false, desc: 'Découverte' },
            { days: 14, price: '6 000', perDay: '429', popular: true, desc: 'Le plus choisi' },
            { days: 30, price: '12 000', perDay: '400', popular: false, desc: 'Économique' },
          ].map((tier) => (
            <div
              key={tier.days}
              className={`relative flex flex-col rounded-2xl border bg-surface p-6 text-left shadow-sm transition hover:shadow-md hover:-translate-y-0.5 ${tier.popular ? 'border-accent shadow-glow' : 'border-border'}`}
            >
              {tier.popular && (
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-accent px-3 py-1 text-xs font-black uppercase tracking-wide text-on-accent shadow">
                  Le plus choisi
                </span>
              )}
              <p className="text-xs font-bold uppercase tracking-widest text-accent">{tier.desc}</p>
              <h3 className="mt-1 text-xl font-black">{tier.days} jours</h3>
              <div className="mt-3 flex items-baseline gap-2">
                <span className="text-3xl font-black">{tier.price}</span>
                <span className="text-sm font-semibold text-muted">FCFA</span>
              </div>
              <p className="mt-1 text-xs text-muted">Soit {tier.perDay} FCFA / jour</p>
              <ul className="mt-4 space-y-2 text-sm">
                <li className="flex items-center gap-2">
                  <Icon.Check size={14} aria-hidden className="text-success" /> Qualité adaptative
                </li>
                <li className="flex items-center gap-2">
                  <Icon.Check size={14} aria-hidden className="text-success" /> Tous appareils
                </li>
                <li className="flex items-center gap-2">
                  <Icon.Check size={14} aria-hidden className="text-success" /> Support WhatsApp
                </li>
              </ul>
              <a
                href={`${WHATSAPP_BASE}?text=${encodeURIComponent(`Bonjour Mbolo TV, je veux un code ${tier.days} jours.`)}`}
                target="_blank"
                rel="noreferrer"
                className={`mt-6 inline-flex items-center justify-center rounded-xl px-4 py-3 text-sm font-bold transition ${tier.popular ? 'bg-accent text-on-accent hover:bg-accent-hover shadow' : 'border border-border bg-surface-2 hover:bg-surface-3'}`}
              >
                Obtenir {tier.days}j sur WhatsApp
              </a>
            </div>
          ))}
        </div>

        <div className="mt-4 rounded-2xl border border-dashed border-accent/30 bg-accent-muted p-4 text-center md:flex md:items-center md:justify-between md:text-left">
          <div>
            <p className="text-sm font-black">Promo 24h — découvrir sans engagement</p>
            <p className="mt-1 text-xs text-muted">Idéal pour tester la qualité avant de prendre 7/14/30 jours.</p>
          </div>
          <a
            href={`${WHATSAPP_BASE}?text=${encodeURIComponent('Bonjour Mbolo TV, je veux un code promo 24h.')}`}
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-flex items-center justify-center rounded-xl border border-accent/30 bg-surface px-4 py-2.5 text-sm font-bold hover:bg-surface-2 transition md:mt-0"
          >
            Demander promo 24h
          </a>
        </div>
      </section>

      {/* ===== DEVICE STORY ===== */}
      <section id="telechargement" className="relative z-10 mx-auto w-full max-w-5xl px-5 py-10 scroll-mt-8">
        <div className="grid gap-6 md:grid-cols-2 md:items-center">
          <div>
            <p className="text-xs font-bold uppercase tracking-widest text-accent">Partout avec vous</p>
            <h2 className="mt-2 text-2xl font-black tracking-tight md:text-3xl">Télé, téléphone, tablette</h2>
            <p className="mt-3 text-sm leading-relaxed text-muted">
              PWA installable en 1 tap. Reprenez le direct où vous l’avez laissé, qualité adaptative selon votre connexion.
            </p>
            <ul className="mt-4 space-y-2 text-sm">
              <li className="flex items-center gap-2">
                <Icon.Check size={16} aria-hidden className="text-success" /> Installation sans store
              </li>
              <li className="flex items-center gap-2">
                <Icon.Check size={16} aria-hidden className="text-success" /> Mode éco pour petites connexions
              </li>
              <li className="flex items-center gap-2">
                <Icon.Check size={16} aria-hidden className="text-success" /> Reprise instantanée
              </li>
            </ul>

            <div className="mt-6 flex flex-wrap gap-3">
              <a
                href="https://github.com/justebruneel/mbolotv/releases/latest/download/mbolo-tv-android.apk"
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-accent px-5 py-3 text-sm font-bold text-on-accent shadow transition hover:bg-accent-hover"
              >
                <Icon.Monitor size={16} aria-hidden /> Android — Télécharger l’app
              </a>
              <a
                href="https://github.com/justebruneel/mbolotv/releases/latest/download/mbolo-tv-android-tv.apk"
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-surface-2 px-5 py-3 text-sm font-bold transition hover:bg-surface-3"
              >
                <Icon.Tv size={16} aria-hidden /> Android TV — Télécharger l’app
              </a>
            </div>
            <p className="mt-3 text-xs text-muted">
              APK signé · Android 6+ · ~100 Ko. Autorisez « sources inconnues » à l’installation.
            </p>
          </div>

          <div className="relative flex items-end justify-center gap-4">
            {/* TV mockup */}
            <div className="relative w-[68%] overflow-hidden rounded-2xl border border-border bg-surface shadow-xl">
              <div className="h-6 border-b border-border bg-surface-2 flex items-center gap-1.5 px-3">
                <span className="h-2 w-2 rounded-full bg-danger" /> <span className="h-2 w-2 rounded-full bg-warning" /> <span className="h-2 w-2 rounded-full bg-success" />
                <span className="ml-2 text-[10px] font-semibold text-muted">Mbolo TV — Live</span>
              </div>
              <div className="aspect-video bg-gradient-to-br from-surface-3 to-bg flex items-center justify-center">
                <div className="flex flex-col items-center gap-2">
                  <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-accent text-on-accent">
                    <Icon.Play size={18} aria-hidden />
                  </span>
                  <span className="text-xs font-bold">Direct HD</span>
                  <span className="text-[11px] text-muted">Adaptatif • Sans coupure</span>
                </div>
              </div>
            </div>
            {/* Phone mockup */}
            <div className="relative w-[32%] overflow-hidden rounded-[1.4rem] border border-border bg-surface shadow-xl">
              <div className="h-3 bg-surface-2" />
              <div className="aspect-[9/16] bg-gradient-to-br from-accent/10 via-surface to-bg flex flex-col items-center justify-center p-3 text-center">
                <Icon.Monitor size={20} aria-hidden className="text-accent" />
                <span className="mt-2 text-xs font-black">Mbolo TV</span>
                <span className="mt-1 text-[11px] leading-tight text-muted">Ajouter à l’écran d’accueil pour le mode plein écran.</span>
                <span className="mt-3 inline-flex rounded-full bg-accent px-3 py-1 text-[11px] font-bold text-on-accent">Installer</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ===== FAQ ===== */}
      <section className="relative z-10 mx-auto w-full max-w-3xl px-5 py-10">
        <h2 className="text-center text-xl font-black tracking-tight md:text-2xl">Questions fréquentes</h2>
        <p className="mt-2 text-center text-sm text-muted">Tout ce que vous devez savoir avant d’activer votre code.</p>
        <div className="mt-6 space-y-3">
          {[
            {
              q: 'Un code = un appareil, que faire si je change de téléphone ?',
              a: 'Votre code est lié au premier appareil qui l’active (empreinte anonyme). Si vous changez d’appareil, contactez-nous sur WhatsApp avec les 4 derniers caractères de votre code : nous le réassocions en quelques minutes.',
            },
            {
              q: 'Comment recevoir mon code sur WhatsApp ?',
              a: 'Cliquez sur “Obtenir sur WhatsApp”, envoyez “Je veux 7/14/30 jours” et votre paiement. Vous recevez un code type MBLO-XXXX en 2 minutes, valable immédiatement.',
            },
            {
              q: 'Quelle consommation en mode éco ?',
              a: 'Le mode éco (disponible dans le lecteur) limite la résolution pour économiser jusqu’à 60% de data — idéal en 3G/4G. La qualité adaptative ajuste aussi automatiquement sans couper.',
            },
            {
              q: 'Puis-je installer sur TV ?',
              a: 'Oui : sur Android TV, utilisez le navigateur ou ajoutez la PWA. Sur télé connectée, ouvrez mbolo.tv dans le navigateur intégré. L’app s’installe sans store.',
            },
            {
              q: 'Que signifie “Mbolo TV n’héberge pas de flux” ?',
              a: 'Nous n’hébergeons ni ne fournissons les flux : vous renseignez vos sources autorisées via la console propriétaire, nous les agrégeons et sécurisons l’accès. Transparence totale.',
            },
          ].map((item) => (
            <details key={item.q} className="group rounded-xl border border-border bg-surface p-4 open:shadow-sm transition">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-sm font-bold">
                {item.q}
                <Icon.ChevronDown size={16} aria-hidden className="shrink-0 text-muted transition group-open:rotate-180" />
              </summary>
              <p className="mt-3 text-sm leading-relaxed text-muted">{item.a}</p>
            </details>
          ))}
        </div>
      </section>

      {/* ===== FOOTER 4 COLONNES ===== */}
      <footer className="relative z-10 border-t border-border bg-surface/50 backdrop-blur">
        <div className="mx-auto grid max-w-6xl gap-8 px-5 py-10 sm:grid-cols-2 md:grid-cols-4">
          <div>
            <Logo />
            <p className="mt-3 text-sm leading-relaxed text-muted">Le direct sans limites, par le Groupe Nzogho. Streaming adaptatif, multi-sources, respect de la vie privée.</p>
            <p className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-muted">
              <Icon.ShieldCheck size={14} aria-hidden className="text-success" /> Paiement WhatsApp • Support 7j/7
            </p>
          </div>
          <div>
            <h4 className="text-sm font-black uppercase tracking-wide">Produit</h4>
            <ul className="mt-3 space-y-2 text-sm text-muted">
              <li>
                <a href="/live" className="hover:text-foreground hover:underline">
                  Live TV
                </a>
              </li>
              <li>
                <a href="/favorites" className="hover:text-foreground hover:underline">
                  Favoris
                </a>
              </li>
              <li>
                <button type="button" onClick={() => scrollToId('offres')} className="hover:text-foreground hover:underline">
                  Offres 7/14/30j
                </button>
              </li>
              <li>
                <a href="/docs" className="hover:text-foreground hover:underline">
                  Documentation
                </a>
              </li>
            </ul>
          </div>
          <div>
            <h4 className="text-sm font-black uppercase tracking-wide">Aide</h4>
            <ul className="mt-3 space-y-2 text-sm text-muted">
              <li>
                <a href={WHATSAPP_BASE} target="_blank" rel="noreferrer" className="hover:text-foreground hover:underline">
                  WhatsApp
                </a>
              </li>
              <li>
                <a href="/help" className="hover:text-foreground hover:underline">
                  Centre d’aide
                </a>
              </li>
              <li>
                <a href="/contact" className="hover:text-foreground hover:underline">
                  Contact
                </a>
              </li>
              <li>
                <a href="/about" className="hover:text-foreground hover:underline">
                  À propos
                </a>
              </li>
            </ul>
          </div>
          <div>
            <h4 className="text-sm font-black uppercase tracking-wide">Légal</h4>
            <ul className="mt-3 space-y-2 text-sm text-muted">
              <li className="text-xs leading-relaxed">Mbolo TV n’héberge ni ne fournit de flux — agrégation de sources autorisées uniquement.</li>
              <li>
                <a href="/about" className="hover:text-foreground hover:underline">
                  Mentions légales
                </a>
              </li>
              <li className="text-xs text-faint">© {new Date().getFullYear()} Groupe Nzogho — Tous droits réservés.</li>
            </ul>
          </div>
        </div>
      </footer>
    </main>
  );
}
