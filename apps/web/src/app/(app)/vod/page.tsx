'use client';

import { Icon, Spinner } from '@mbolo/ui';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { ResumeRow, VodHome } from '../../../features/vod/components/home/VodHome';
import { ExternalBrowse, VodBrowse, type ExternalSort } from '../../../features/vod/components/browse/BrowseGrids';
import { DossierView, VodSearch, type SearchSection } from '../../../features/vod/components/browse/SearchSections';
import { useVodCategories, useVodFolders } from '../../../shared/api/queries';
import { Tab, folderSearchSections } from '../../../features/vod/vodUtils';

// Dossier ouvert = slug géré dans la console (« Catalogue VOD »). La valeur
// 'nollywood' est le slug seedé — les liens historiques ?kind=NOLLYWOOD et
// ?dossier=nollywood y sont canonicalisés.
type Dossier = string | null;

function isVodKind(value: string | null): value is Tab {
  return value === 'MOVIE' || value === 'SERIES';
}

// Seuil de scroll (px) au-delà duquel le bouton « retour en haut » apparaît.
const BACK_TO_TOP_THRESHOLD = 600;

const SORT_OPTIONS: Array<{ value: ExternalSort; label: string }> = [
  { value: 'recent', label: 'Récents' },
  { value: 'year', label: 'Nouveautés' },
  { value: 'title', label: 'Titre A–Z' },
];

function VodPageContent() {
  const searchParams = useSearchParams();
  const q = searchParams.get('q') ?? '';
  // Onglet actif : ?kind= (Films par défaut). L'URL fait foi pour les liens
  // directs et le retour navigateur — pas d'état persisté superflu.
  const [tab, setTab] = useState<Tab>(() => {
    const value = searchParams.get('kind');
    return value === 'NOLLYWOOD' ? 'MOVIE' : isVodKind(value) ? value : 'MOVIE';
  });
  // Dossier ouvert (collection de l'onglet) : ?dossier=<slug>. Les anciens
  // liens ?kind=NOLLYWOOD sont remappés vers le slug seedé « nollywood ».
  const [dossier, setDossier] = useState<Dossier>(() => {
    const param = searchParams.get('dossier');
    if (param) return param;
    return searchParams.get('kind') === 'NOLLYWOOD' ? 'nollywood' : null;
  });
  // Filtres portés par l'URL (?cat=, ?ext=1, ?genre=) : le retour navigateur
  // (remontée depuis une fiche) restaure la vue exacte laissée — même motif
  // que tab/dossier ci-dessus. Les setters écrivent le state (rendu
  // immédiat) ET l'URL (historique).
  const [category, setCategoryState] = useState<string | null>(() => searchParams.get('cat'));
  const [browseExternal, setBrowseExternalState] = useState<boolean>(() => searchParams.get('ext') === '1');
  const [browseGenre, setBrowseGenreState] = useState<string | null>(() => searchParams.get('genre'));
  const writeVodParams = (mutate: (params: URLSearchParams) => void): void => {
    const url = new URL(window.location.href);
    mutate(url.searchParams);
    window.history.replaceState(null, '', url.toString());
  };
  const setCategory = (value: string | null): void => {
    setCategoryState(value);
    writeVodParams((params) => (value ? params.set('cat', value) : params.delete('cat')));
  };
  const setBrowseExternal = (value: boolean): void => {
    setBrowseExternalState(value);
    writeVodParams((params) => (value ? params.set('ext', '1') : params.delete('ext')));
  };
  const setBrowseGenre = (value: string | null): void => {
    setBrowseGenreState(value);
    writeVodParams((params) => (value ? params.set('genre', value) : params.delete('genre')));
  };
  // Tri des grilles « voir tout » titres externes (state local, pas d'URL :
  // le tri n'est pas un filtre de navigation).
  const [browseSort, setBrowseSort] = useState<ExternalSort>('recent');
  const [showBackToTop, setShowBackToTop] = useState(false);

  const kindParam = searchParams.get('kind');
  const dossierParam = searchParams.get('dossier');
  // Synchronisation depuis l'URL (navigation, replaceState du routeur).
  // Déclaré AVANT l'effet legacy : sur un lien ?kind=NOLLYWOOD, dossierParam
  // vaut null au montage et cet effet remettrait le dossier à null — le
  // remap legacy (ci-dessous) doit passer en dernier pour gagner.
  useEffect(() => {
    const next: Dossier = dossierParam ?? null;
    setDossier((prev) => (prev === next ? prev : next));
  }, [dossierParam]);
  useEffect(() => {
    if (kindParam === 'NOLLYWOOD') {
      // Ancien onglet devenu dossier : canonicalise l'URL pour les liens
      // déjà partagés.
      setTab('MOVIE');
      setDossier('nollywood');
      const url = new URL(window.location.href);
      url.searchParams.set('kind', 'MOVIE');
      url.searchParams.set('dossier', 'nollywood');
      window.history.replaceState(null, '', url.toString());
      return;
    }
    if (isVodKind(kindParam)) setTab(kindParam);
  }, [kindParam]);
  const prevTabRef = useRef(tab);
  useEffect(() => {
    if (prevTabRef.current === tab) return;
    prevTabRef.current = tab;
    setCategory(null);
    setBrowseExternal(false);
    setBrowseGenre(null);
  }, [tab]);

  // Bouton « retour en haut » (voir-tout et dossiers défilent beaucoup) :
  // visible après un écran de scroll, discret et non intrusif.
  useEffect(() => {
    const onScroll = () => setShowBackToTop(window.scrollY > BACK_TO_TOP_THRESHOLD);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const categories = useVodCategories(tab);
  // Dossiers de la console ; erreur ou liste vide = comportement historique.
  const foldersQuery = useVodFolders(tab);
  const folders = foldersQuery.isError ? [] : foldersQuery.data?.folders ?? [];

  const switchTab = (next: Tab): void => {
    setTab(next);
    setBrowseExternal(false);
    setBrowseGenre(null);
    setCategory(null);
    const url = new URL(window.location.href);
    url.searchParams.set('kind', next);
    url.searchParams.delete('dossier');
    url.searchParams.delete('cat');
    url.searchParams.delete('ext');
    url.searchParams.delete('genre');
    window.history.replaceState(null, '', url.toString());
  };

  const openDossier = (slug: string | null): void => {
    setDossier(slug);
    const url = new URL(window.location.href);
    if (slug) url.searchParams.set('dossier', slug);
    else url.searchParams.delete('dossier');
    window.history.replaceState(null, '', url.toString());
  };

  const dossierFolder = dossier ? folders.find((folder) => folder.slug === dossier) : undefined;
  // Recherche fusionnée : UNE section par dossier (toutes ses chaînes
  // mélangées, sans nom de chaîne). Dossiers extensibles : chaque nouveau
  // dossier console apparaît comme une section générique.
  const searchFolders = useMemo<SearchSection[]>(() => folderSearchSections(folders), [folders]);

  const showTabsBar = !dossier && !category && !browseExternal && !browseGenre && (folders.length > 0 || (categories.data?.length ?? 0) > 1);
  const onBrowseExternal = () => setBrowseExternal(true);
  const onBrowseGenre = (genre: string) => setBrowseGenre(genre);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6">
      {/* Onglets Films / Séries façon Netflix : navigation ancrée en haut de
          page, texte seul, l'onglet actif en gras blanc, l'inactif atténué —
          pas de pills (Netflix n'en a pas), la hiérarchie passe par le poids. */}
      <div className="mb-5 flex items-center justify-between gap-3">
        <nav className="flex items-center gap-5" role="tablist" aria-label="Type de contenu">
          {(['MOVIE', 'SERIES'] as const).map((value) => (
            <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => switchTab(value)}
              className={`relative pb-1 text-lg font-bold transition md:text-xl ${tab === value ? 'text-foreground' : 'text-muted hover:text-foreground/70'}`}>
              {value === 'MOVIE' ? 'Films' : 'Séries'}
              {/* Soulignement accent sous l'onglet actif (marqueur Netflix). */}
              {tab === value && <span className="absolute inset-x-0 -bottom-0.5 h-0.5 rounded-full bg-accent" aria-hidden />}
            </button>
          ))}
        </nav>
        {(category || browseExternal || browseGenre || dossier) && (
          <button type="button" onClick={() => { setCategory(null); setBrowseExternal(false); setBrowseGenre(null); openDossier(null); }} className="btn">
            <Icon.ChevronLeft size={14} /> Accueil {tab === 'MOVIE' ? 'films' : 'séries'}
          </button>
        )}
      </div>
      {/* Reprendre : accueil uniquement — dans les vues filtrées (« voir
          tout », dossier, catégorie, recherche) la grille EST le contenu,
          une rangée de reprise décalerait tout vers le bas sans servir. */}
      {!q && !dossier && !category && !browseExternal && !browseGenre && <ResumeRow />}
      {/* Barre dossiers + catégories : ACCUEIL de l'onglet uniquement. Dans
          les vues filtrées (dossier ouvert, catégorie, « voir tout »), ces
          filtres n'opèrent plus sur le contenu affiché (une grille de
          dossier n'est pas filtrable par catégorie) — les garder affichés
          avec un élément actif en surface = un doublon au-dessus de la
          grille + des boutons sans effet. Le bouton « ← Accueil » en tête
          de page suffit à revenir. */}
      {showTabsBar && (
        <div className="mb-5 flex items-center gap-4 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {folders.map((folder) => (
            <button key={folder.id} type="button" onClick={() => openDossier(folder.slug)}
              className={`relative shrink-0 pb-0.5 text-sm font-bold transition ${dossier === folder.slug ? 'text-foreground' : 'text-muted hover:text-foreground/70'}`}>
              {folder.name}
              {dossier === folder.slug && <span className="absolute inset-x-0 -bottom-0.5 h-0.5 rounded-full bg-accent" aria-hidden />}
            </button>
          ))}
          {folders.length > 0 && (categories.data?.length ?? 0) > 1 && <span className="h-4 w-px shrink-0 bg-border" aria-hidden />}
          {categories.data && categories.data.length > 1 && (
            <>
              <button type="button" onClick={() => setCategory(null)}
                className={`relative shrink-0 pb-0.5 text-sm font-bold transition ${category === null ? 'text-foreground' : 'text-muted hover:text-foreground/70'}`}>
                Tout
                {category === null && <span className="absolute inset-x-0 -bottom-0.5 h-0.5 rounded-full bg-accent" aria-hidden />}
              </button>
              {categories.data.map((entry) => (
                <button key={entry.name} type="button" onClick={() => { setCategory(category === entry.name ? null : entry.name); setBrowseExternal(false); setBrowseGenre(null); }}
                  className={`relative shrink-0 pb-0.5 text-sm font-bold transition ${category === entry.name ? 'text-foreground' : 'text-muted hover:text-foreground/70'}`}>
                  {/* Libellé nettoyé à l'écran, clé brute pour le filtre. */}
                  {entry.label ?? entry.name}
                  {category === entry.name && <span className="absolute inset-x-0 -bottom-0.5 h-0.5 rounded-full bg-accent" aria-hidden />}
                </button>
              ))}
            </>
          )}
        </div>
      )}
      <Suspense fallback={<div className="flex justify-center py-16"><Spinner /></div>}>
        {dossier
          ? <DossierView slug={dossier} q={q} folder={dossierFolder ?? (foldersQuery.isPending ? undefined : null)} />
          : !q && !category && !browseExternal && !browseGenre
            ? <VodHome kind={tab} onBrowseExternal={onBrowseExternal} onBrowseGenre={onBrowseGenre} folders={folders} />
            : browseExternal && !q
              ? <>
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                    <h2 className="text-xl font-bold">{tab === 'SERIES' ? 'Séries' : 'Films'} — tout le catalogue</h2>
                    <SortPicker value={browseSort} onChange={setBrowseSort} />
                  </div>
                  <ExternalBrowse q="" kind={tab} sort={browseSort} />
                </>
              : browseGenre && !q
                ? <>
                    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                      <h2 className="text-xl font-bold">{browseGenre} — tout le catalogue</h2>
                      <SortPicker value={browseSort} onChange={setBrowseSort} />
                    </div>
                    <ExternalBrowse q="" kind={tab} genre={browseGenre} sort={browseSort} />
                  </>
              : q ? (
                <VodSearch kind={tab} category={category} q={q} folders={folders} searchFolders={searchFolders} />
              )
              : <VodBrowse kind={tab} category={category} q={q} />}
      </Suspense>
      {showBackToTop && (
        <button type="button" aria-label="Retour en haut de page" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          className="fixed bottom-5 right-5 z-40 flex h-11 w-11 items-center justify-center rounded-full bg-surface text-muted shadow-lg ring-1 ring-border transition hover:bg-accent hover:text-on-accent">
          <Icon.ArrowUp size={18} />
        </button>
      )}
    </div>
  );
}

// Sélecteur de tri des grilles « voir tout » titres externes : pills
// Récents / Nouveautés / Titre A–Z.
function SortPicker({ value, onChange }: { value: ExternalSort; onChange: (value: ExternalSort) => void }) {
  return (
    <div role="group" aria-label="Tri du catalogue" className="flex items-center gap-1 rounded-full border border-border bg-surface p-0.5">
      {SORT_OPTIONS.map((option) => (
        <button key={option.value} type="button" onClick={() => onChange(option.value)}
          className={`rounded-full px-3 py-1 text-xs font-semibold transition ${value === option.value ? 'bg-accent text-on-accent' : 'text-muted hover:text-foreground'}`}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

export default function VodPage() {
  return (
    <Suspense fallback={<div className="flex justify-center py-16"><Spinner /></div>}>
      <VodPageContent />
    </Suspense>
  );
}