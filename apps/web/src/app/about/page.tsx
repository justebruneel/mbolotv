import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'À propos',
  description:
    'Mbolo TV agrège des sources autorisées dans une interface claire : direct adaptatif, guide des programmes, favoris par appareil. Sans hébergement de flux, par le Groupe Nzogho.',
};

const WHATSAPP_URL = 'https://wa.me/24160108984';

const VALUES = [
  {
    title: 'Lecture fluide',
    body: 'Direct en qualité adaptative (ABR HLS) : le lecteur suit votre connexion et revient seul après une coupure réseau, sans recharger la page.',
  },
  {
    title: 'Catalogue clair',
    body: 'Recherche instantanée, catégories, pays, guide des programmes (EPG) et favoris rattachés à votre appareil.',
  },
  {
    title: 'Sécurité',
    body: 'Les identifiants de vos sources restent chiffrés côté serveur et ne sont jamais transmis au navigateur. La lecture passe par un proxy contrôlé.',
  },
  {
    title: 'Partout avec vous',
    body: 'Télé, téléphone, tablette : application web installable (PWA) et applications Android / Android TV.',
  },
];

export default function AboutPage() {
  return (
    <article className="mx-auto max-w-3xl space-y-10 px-4 py-10 text-foreground sm:px-6">
      <header className="space-y-3">
        <p className="text-sm font-bold uppercase tracking-[.16em] text-accent">Mbolo TV</p>
        <h1 className="text-4xl font-bold tracking-tight">Le direct, simple et responsable.</h1>
        <p className="text-lg leading-8 text-muted">
          Mbolo TV rassemble vos chaînes en direct dans une interface claire : lecture adaptative, guide des programmes,
          favoris par appareil. L&rsquo;application ne publie pas de flux — elle agrège uniquement des sources que vous
          configurez et auxquelles vous avez légitimement accès.
        </p>
      </header>

      <section aria-label="Nos engagements" className="grid gap-4 sm:grid-cols-2">
        {VALUES.map((value) => (
          <div key={value.title} className="rounded-2xl border border-border bg-surface p-5">
            <h2 className="font-bold">{value.title}</h2>
            <p className="mt-2 text-sm leading-6 text-muted">{value.body}</p>
          </div>
        ))}
      </section>

      <section className="space-y-3 rounded-2xl border border-border bg-surface p-6">
        <h2 className="text-xl font-bold">Transparence</h2>
        <p className="leading-7 text-muted">
          Mbolo TV n&rsquo;héberge ni ne fournit de contenu audiovisuel. Les chaînes proviennent de sources configurées
          par l&rsquo;exploitant du service (abonnements IPTV légitimes), agrégées et sécurisées par notre plateforme. Les
          secrets de ces sources restent côté serveur, chiffrés : le navigateur ne voit que des liens de lecture
          temporaires.
        </p>
        <p className="leading-7 text-muted">
          Vos favoris et préférences sont rattachés à un identifiant d&rsquo;appareil anonyme — jamais de compte, jamais
          de données personnelles revendues.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-bold">Qui sommes-nous&nbsp;?</h2>
        <p className="leading-7 text-muted">
          Mbolo TV est développé et opéré par le <strong className="text-foreground">Groupe Nzogho</strong>, avec un
          support humain 7j/7 sur WhatsApp. Une question, un bug, une suggestion&nbsp;? Écrivez-nous — nous lisons tout.
        </p>
        <div className="flex flex-wrap gap-3 pt-1">
          <Link
            href="/contact"
            className="inline-flex items-center gap-2 rounded-xl bg-accent px-5 py-3 text-sm font-bold text-on-accent transition hover:bg-accent-hover"
          >
            Contacter le support
          </Link>
          <a
            href={WHATSAPP_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-xl border border-border bg-surface px-5 py-3 text-sm font-bold transition hover:bg-surface-2"
          >
            WhatsApp 7j/7
          </a>
          <Link
            href="/help"
            className="inline-flex items-center gap-2 rounded-xl border border-border bg-surface px-5 py-3 text-sm font-bold transition hover:bg-surface-2"
          >
            Centre d&rsquo;aide
          </Link>
        </div>
      </section>

      <p className="text-sm text-faint">© {new Date().getFullYear()} Groupe Nzogho — Tous droits réservés.</p>
    </article>
  );
}
