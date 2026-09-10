# Films & Séries — plan d'implémentation (3 phases)

## Phase 1 — Refactors (aucun changement visuel, commit séparé)
1. `apps/web/src/shared/utils/formatTime.ts` : extraire `formatTime` (copies dans `vod/page.tsx:33`, `vod/[id]/page.tsx:14`, `vod/yt/[videoId]/page.tsx:21`) + remplacer les 3 usages.
2. `apps/web/src/shared/hooks/useInfiniteScroll.ts` : extraire le pattern `IntersectionObserver + sentinelle + loadingMore` (5× dans `vod/page.tsx` : VodBrowse/FolderVodBrowse/YoutubeBrowse/MergedYoutubeBrowse/ExternalBrowse).
3. `features/vod/components/ExternalTile.tsx` : réutiliser `MediaTile` (coquille dupliquée supprimée).
4. Découpage de `vod/page.tsx` (851 lignes) :
   - `features/vod/vodUtils.ts` : `Tab`, `PAGE_SIZE`, `dossierHref`, `NOLLYWOOD_DOSSIER_HREF`, `dedupeYoutubeItems`, `resumeHref`, `folderSearchSections`.
   - `features/vod/components/home/VodHome.tsx` : `ResumeRow`, `FolderOne`, `NollywoodOnly`, `VodHomeEmpty`, `VodHome`, `ExternalRail`, `ExternalGenreRail(s)`, `FolderRail/FolderMergedRail/FolderYoutubeRail/NollywoodRail`.
   - `features/vod/components/browse/BrowseGrids.tsx` : `VodBrowse`, `FolderVodBrowse`, `YoutubeBrowse`, `MergedYoutubeBrowse`, `ExternalBrowse`, `useSectionSettled`.
   - `features/vod/components/browse/SearchSections.tsx` : `ExternalSearch`, `FolderSearchSection`, `NollywoodSearchSection`, `VodSearch`, `DossierView`.
   - `vod/page.tsx` : ne garde que `VodPageContent` (state URL, onglets, dossiers) + `VodPage`.

## Phase 2 — UX sur la page et les fiches
5. Skeletons (grille tuiles + rangée Reprendre) à la place des `Spinner` centrés (`VodHome`, grilles browse).
6. Bouton « Réessayer » (`query.refetch()`) sur les `EmptyState` d'erreur (home + grilles).
7. Bouton « retour en haut » flottant (seuil ~1 écran) dans `VodPageContent`.
8. « Voir plus » dans les sections de recherche : `ExternalSearch` (12 items → grille entière), `FolderSearchSection`/`NollywoodSearchSection` (25 → grille entière) — état local + `useInfiniteScroll`.
9. Tri sur « tout le catalogue » (`browseExternal`) : Récents / Nouveautés (année) / Titre A→Z. Ajout `sort=title` :
   - NestJS : `external.controller.ts` + `vod.service.ts` (`orderBy: [{ title: 'asc' }]`).
   - Worker : `external.js` `listExternalTitles` (`order` case).
   - Front : `useInfiniteExternalTitles` accepte `'title'`.
10. « Sur le même thème » :
    - Fiche externe `vod/x/[id]/page.tsx` : rail `useInfiniteExternalTitles('', 12, kind, premierGenre)` hors id courant (réutilise `ExternalRow`).
    - Fiche YouTube `vod/yt/[videoId]/page.tsx` : rail « plus de cette chaîne » (repli `useInfiniteYoutube(channelId)` si connu).
    - Xtream `vod/[id]` : skip (catalogue Xtream vide aujourd'hui).

## Phase 3 — Favoris externes synchronisés
11. Prisma `ExternalFavorite` (miroir de `VodFavorite`) : `deviceId + externalTitleId (+ createdAt)`, relation `ExternalTitle`, index `[deviceId, createdAt]`.
12. Migration Prisma ; **pause de confirmation avant exécution sur Neon prod** (acceptée par l'utilisateur).
13. NestJS : `GET /x/favorites`, `PUT /x/:id/favorite`, `DELETE /x/:id/favorite` (AccessGuard, device obligatoire, idempotent P2002/P2025) + spec miroir de `vod-favorites.spec.ts`.
14. Worker `mbolo-tv-api` : mêmes 3 routes (API prod = Worker), SQL miroir de `external.js`/`vod.js`.
15. Store `externalFavorites.ts` : local-first + sync serveur (GET au hydrate, PUT/DELETE optimistes via `x-device-id`, merge serveur≥local, metadata locales conservées).
16. Page Favoris (`favorites/page.tsx`) : l'onglet Films & Séries fusionne favoris VOD serveur + favoris externes serveur + locaux.

## Vérification
- `pnpm typecheck`, `pnpm --filter @mbolo/web lint`, `pnpm --filter @mbolo/web build`, `pnpm --filter @mbolo/api test` (spec favoris externes ajoutée).
- 3 commits logiques + push. Les favoris YouTube restent 100 % locaux (hors périmètre).

## Fichiers touchés
- web : `shared/utils/formatTime.ts` (+ 3 remplacements), `shared/hooks/useInfiniteScroll.ts`, `features/vod/vodUtils.ts`, `features/vod/components/home/VodHome.tsx`, `.../browse/BrowseGrids.tsx`, `.../browse/SearchSections.tsx`, `.../ExternalTile.tsx`, `(app)/vod/page.tsx`, `(app)/vod/x/[id]/page.tsx`, `(app)/vod/yt/[videoId]/page.tsx`, `(app)/favorites/page.tsx`, `shared/api/queries.ts`, `shared/stores/externalFavorites.ts`
- api : `prisma/schema.prisma` + migration, `modules/vod/external.controller.ts`, `modules/vod/vod.service.ts`, `modules/vod/external-favorites.spec.ts`
- worker : `src/external.js` (list), `src/index.js` (routes favorites)