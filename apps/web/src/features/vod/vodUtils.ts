import type { VodFolderSummary, YoutubeVideo } from '@mbolo/contracts';

// Constantes et helpers partagés de la page Films & Séries, extraits du
// monolithe (app)/(app)/vod/page.tsx pour répartition par module.

export type Tab = 'MOVIE' | 'SERIES';

export const PAGE_SIZE = 48;

// Dossier ouvert = slug géré dans la console (« Catalogue VOD »). La valeur
// 'nollywood' est le slug seedé — les liens historiques ?kind=NOLLYWOOD et
// ?dossier=nollywood y sont canonicalisés.
export function dossierHref(kind: Tab, slug: string): string {
  return `/vod?${new URLSearchParams({ kind, dossier: slug }).toString()}`;
}

export const NOLLYWOOD_DOSSIER_HREF = dossierHref('MOVIE', 'nollywood');

// Dédupe par id : un décalage playlistItems (nouvelle vidéo publiée entre
// deux pages) duplique un item — collision de key React + visuel doublé.
export function dedupeYoutubeItems(items: YoutubeVideo[]): YoutubeVideo[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

// Lien d'une tuile « Reprendre » : les entrées sont préfixées par leur espace
// (yt: Nollywood, x: titres externes) pour ne pas collisionner avec les ids
// VodItem Xtream ; sans préfixe => fiche VOD Xtream classique.
export function resumeHref(id: string): string {
  if (id.startsWith('yt:')) return `/vod/yt/${id.slice(3)}`;
  if (id.startsWith('x:')) return `/vod/x/${id.slice(2)}`;
  return `/vod/${id}`;
}

// Recherche fusionnée : UNE section par dossier (toutes ses chaînes mélangées,
// sans nom de chaîne). Dossiers extensibles : chaque nouveau dossier console
// apparaît comme une section générique.
export function folderSearchSections(folders: VodFolderSummary[]): Array<{ id: string; name: string; channelIds: string[] }> {
  return folders
    .filter((folder) => folder.youtubeSources.length > 0)
    .map((folder) => ({
      id: folder.id,
      name: folder.name,
      channelIds: folder.youtubeSources.map((source) => source.channelId),
    }));
}