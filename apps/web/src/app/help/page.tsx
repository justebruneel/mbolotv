import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Centre d’aide',
  description: 'Mode d’emploi Mbolo TV : regarder une chaîne, qualité et économie de données, favoris, installation PWA et dépannage rapide.',
};

export default function HelpPage() {
  return (
    <article className="mx-auto max-w-3xl space-y-10 px-4 py-10 text-foreground sm:px-6">
      <header className="space-y-3">
        <p className="text-sm font-bold uppercase tracking-[.16em] text-accent">Support</p>
        <h1 className="text-4xl font-bold tracking-tight">Centre d&rsquo;aide</h1>
        <p className="text-lg leading-8 text-muted">Tout ce qu&rsquo;il faut pour regarder les chaînes, installer l&rsquo;application et résoudre un souci en quelques minutes.</p>
      </header>

      <section className="space-y-4">
        <h2 className="text-2xl font-bold">Regarder une chaîne</h2>
        <p className="leading-7 text-muted">
          Ouvre <Link href="/live" className="font-semibold text-accent hover:underline">Live TV</Link>, choisis une
          catégorie ou recherche une chaîne, puis sélectionne sa tuile. Le lecteur choisit automatiquement une qualité
          adaptée à ta connexion. Depuis le lecteur, le guide « À suivre » affiche les prochains programmes de la chaîne.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-2xl font-bold">Qualité et économie de données</h2>
        <p className="leading-7 text-muted">
          Le mode <strong className="text-foreground">Auto</strong> utilise l&rsquo;ABR HLS : il baisse la qualité quand
          le débit chute et remonte progressivement quand la connexion se stabilise. Le mode{' '}
          <strong className="text-foreground">Éco</strong> limite la définition pour réduire la consommation mobile —
          idéal en 3G/4G. Change de mode dans les réglages du lecteur.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-2xl font-bold">Favoris</h2>
        <p className="leading-7 text-muted">
          Le bouton cœur ajoute ou retire une chaîne de tes favoris. La sélection est conservée sur ton appareil, sans
          exposer de secrets de fournisseur.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-2xl font-bold">Installation</h2>
        <p className="leading-7 text-muted">
          Sur Chrome, Edge ou Android, ouvre le menu du navigateur puis choisis « Installer Mbolo TV ». Sur iPhone et
          iPad, utilise Partager puis « Sur l&rsquo;écran d&rsquo;accueil ». L&rsquo;application fonctionne en HTTPS avec
          un service worker et un manifeste PWA. Des applications Android et Android TV sont aussi disponibles depuis
          la page d&rsquo;accueil.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-2xl font-bold">Dépannage rapide</h2>
        <ul className="space-y-2 leading-7 text-muted">
          <li>
            <strong className="text-foreground">Chaîne qui ne démarre pas</strong> : clique « Réessayer », vérifie ta connexion, puis essaie une autre chaîne. Si le problème concerne toute l&rsquo;application, contacte le support avec le nom de la chaîne et l&rsquo;heure du problème.
          </li>
          <li>
            <strong className="text-foreground">Aucune chaîne visible</strong> : actualise la page et efface les filtres actifs (catégorie, pays, recherche). Vérifie aussi que ton code d&rsquo;accès est encore valide depuis « Mon accès ».
          </li>
          <li>
            <strong className="text-foreground">Logo manquant</strong> : certains logos dépendent de la source ; ce n&rsquo;est pas bloquant pour la lecture.
          </li>
          <li>
            <strong className="text-foreground">Guide vide</strong> : le guide se remplit après l&rsquo;import EPG (la nuit). Réessaie plus tard ou consulte une autre chaîne.
          </li>
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-2xl font-bold">Besoin d&rsquo;aide humaine&nbsp;?</h2>
        <p className="leading-7 text-muted">
          Décris le problème, la chaîne concernée, ton appareil et l&rsquo;heure approximative.{' '}
          <Link className="font-semibold text-accent hover:underline" href="/contact">
            Contacter le support
          </Link>
          .
        </p>
      </section>
    </article>
  );
}
