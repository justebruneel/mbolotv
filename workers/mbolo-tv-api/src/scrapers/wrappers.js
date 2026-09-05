// Suivi des wrappers intermédiaires (kakaflix.lol, kokoflix.lol, …) : ces
// pages ne contiennent pas de vidéo mais un redirect JS statique vers
// l'embed réel (ex. voe). Extractible sans exécuter de JS : 1 hop HTTP.

/**
 * Extrait la cible d'un `window.location[.href] = 'https://…'` statique.
 * Retourne null si aucun redirect (embed direct ou pattern inconnu).
 */
export function extractJsRedirect(html) {
  const source = String(html ?? '');
  const match = /window\.location(?:\.href)?\s*=\s*['"](https?:\/\/[^'"]+)['"]/.exec(source);
  return match?.[1]?.trim() || null;
}


