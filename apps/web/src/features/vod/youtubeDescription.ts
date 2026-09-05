// L'API Data v3 colle parfois l'identifiant de la vidéo en toute fin de
// description (ex. « …#hashtag\n\n\ngF0nvCDVuV0 ») — artefact des uploads
// Aforevo. Affiché tel quel, ce fragmentillisé ressemble à un bug de la fiche :
// on le retire avant exposition (listes, fiches, proxies serveur et Worker).

/** Retire l'ID vidéo collé en fin de description (avec ses sauts de ligne). */
export function stripTrailingVideoId(description: string | null, videoId: string): string | null {
  if (!description) return description;
  const trimmed = description.replace(/\s+$/, '');
  if (!videoId || !trimmed.endsWith(videoId)) return description;
  const rest = trimmed.slice(0, -videoId.length).replace(/\s+$/, '');
  return rest.length > 0 ? rest : description;
}
