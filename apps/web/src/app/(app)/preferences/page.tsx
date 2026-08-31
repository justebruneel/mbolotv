'use client';

import { Icon } from '@mbolo/ui';
import { useState, type ReactNode } from 'react';
import { useTheme } from '../../../shared/components/ThemeProvider';
import { sharedQueryClient } from '../../../shared/components/QueryProvider';
import { useSettingsStore } from '../../../shared/stores/settings';

const THEME_OPTIONS = [
  { value: 'dark', label: 'Sombre', icon: Icon.Moon },
  { value: 'light', label: 'Clair', icon: Icon.Sun },
  { value: 'system', label: 'Système', icon: Icon.Monitor },
] as const;

const QUALITY_OPTIONS = [
  { value: -1, label: 'Auto' },
  { value: 360, label: '360p' },
  { value: 480, label: '480p' },
  { value: 720, label: '720p' },
  { value: 1080, label: '1080p' },
];

function Switch({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className={`relative h-7 w-12 shrink-0 rounded-full border transition ${checked ? 'border-accent bg-accent' : 'border-border bg-surface-2'}`}
    >
      <span className={`absolute top-1/2 h-5 w-5 -translate-y-1/2 rounded-full bg-white shadow transition-all ${checked ? 'left-6' : 'left-0.5'}`} />
    </button>
  );
}

function Row({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-t border-border py-4 first:border-t-0 first:pt-0">
      <div className="min-w-0">
        <p className="text-sm font-bold">{title}</p>
        <p className="mt-0.5 text-xs leading-snug text-muted">{hint}</p>
      </div>
      {children}
    </div>
  );
}

export default function PreferencesPage() {
  const { theme, setTheme } = useTheme();
  const volume = useSettingsStore((state) => state.volume);
  const setVolume = useSettingsStore((state) => state.setVolume);
  const dataSaver = useSettingsStore((state) => state.dataSaver);
  const setDataSaver = useSettingsStore((state) => state.setDataSaver);
  const preferredLevel = useSettingsStore((state) => state.preferredLevel);
  const setPreferredLevel = useSettingsStore((state) => state.setPreferredLevel);
  const autoPlay = useSettingsStore((state) => state.autoPlay);
  const setAutoPlay = useSettingsStore((state) => state.setAutoPlay);
  const miniPlayerOnBrowse = useSettingsStore((state) => state.miniPlayerOnBrowse);
  const setMiniPlayerOnBrowse = useSettingsStore((state) => state.setMiniPlayerOnBrowse);
  const lastWatched = useSettingsStore((state) => state.lastWatched);
  const clearLastWatched = useSettingsStore((state) => state.clearLastWatched);
  const [clearing, setClearing] = useState(false);

  // Purge complète côté client : service worker désinscrit, caches vidés,
  // rechargement — l'app repart du réseau (le SW se réinstalle à la version
  // du dernier déploiement).
  const clearAppCache = async (): Promise<void> => {
    setClearing(true);
    try {
      if ('serviceWorker' in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map((registration) => registration.unregister()));
      }
      if ('caches' in window) {
        const names = await caches.keys();
        await Promise.all(names.map((name) => caches.delete(name)));
      }
    } catch {
      /* stockage indisponible (navigation privée) : on recharge quand même */
    }
    window.location.reload();
  };

  const toggleDataSaver = (): void => {
    setDataSaver(!dataSaver);
    // Une lecture en cours (mini-lecteur inclus) repart sur l'URL éco :
    // la requête ['play'] relue applique eco=1 et le Player recharge la source.
    void sharedQueryClient?.invalidateQueries({ queryKey: ['play'] });
  };

  return (
    <main className="mx-auto max-w-2xl animate-fade-in px-4 py-6 md:px-10">
      <h1 className="text-2xl font-black tracking-tight md:text-3xl">Préférences</h1>
      <p className="mt-1 text-sm text-muted">Réglages de lecture et d'apparence, enregistrés sur cet appareil.</p>

      {/* ===== Apparence ===== */}
      <section className="mt-6 rounded-2xl border border-border bg-surface p-5">
        <h2 className="text-xs font-bold uppercase tracking-widest text-muted">Apparence</h2>
        <div className="mt-3 grid grid-cols-3 gap-2" role="group" aria-label="Thème">
          {THEME_OPTIONS.map((option) => {
            const active = theme === option.value;
            const OptionIcon = option.icon;
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={active}
                onClick={() => setTheme(option.value)}
                className={`flex items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-sm font-bold transition ${
                  active ? 'border-accent bg-accent/10 text-accent' : 'border-border text-muted hover:bg-surface-2 hover:text-foreground'
                }`}
              >
                <OptionIcon size={16} aria-hidden />
                {option.label}
              </button>
            );
          })}
        </div>
      </section>

      {/* ===== Lecture ===== */}
      <section className="mt-4 rounded-2xl border border-border bg-surface p-5">
        <h2 className="text-xs font-bold uppercase tracking-widest text-muted">Lecture</h2>

        <Row title="Mode Éco" hint="Limite la définition (~1 Mbps) pour économiser les données mobiles.">
          <Switch checked={dataSaver} onChange={toggleDataSaver} label="Mode Éco" />
        </Row>

        <Row title="Qualité par défaut" hint="Auto adapte au débit ; une valeur fixe s'applique à chaque nouvelle chaîne.">
          <select
            value={preferredLevel >= 10 ? preferredLevel : -1}
            onChange={(event) => setPreferredLevel(Number(event.target.value))}
            aria-label="Qualité par défaut"
            className="shrink-0 rounded-xl border border-border bg-surface-2 px-3 py-2 text-sm font-semibold text-foreground focus:border-accent focus:outline-none"
          >
            {QUALITY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </Row>

        <Row title="Lecture automatique" hint="À l'ouverture d'une chaîne, la lecture démarre seule. Désactive pour lancer manuellement.">
          <Switch checked={autoPlay} onChange={() => setAutoPlay(!autoPlay)} label="Lecture automatique" />
        </Row>

        <Row title="Mini-lecteur sur l'accueil" hint="La lecture continue en vignette quand tu reviens sur Live TV ou Favoris.">
          <Switch checked={miniPlayerOnBrowse} onChange={() => setMiniPlayerOnBrowse(!miniPlayerOnBrowse)} label="Mini-lecteur sur l'accueil" />
        </Row>

        <Row title="Volume par défaut" hint="Niveau sonore appliqué à chaque nouvelle chaîne.">
          <div className="flex shrink-0 items-center gap-3">
            <Icon.Volume1 size={16} aria-hidden className="text-muted" />
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={Math.round(volume * 100)}
              onChange={(event) => setVolume(Number(event.target.value) / 100)}
              aria-label="Volume par défaut"
              className="h-1.5 w-32 accent-[var(--mbolo-accent)]"
            />
            <span className="w-9 text-right text-xs font-bold tabular-nums text-muted">{Math.round(volume * 100)}%</span>
          </div>
        </Row>
      </section>

      {/* ===== Données ===== */}
      <section className="mt-4 rounded-2xl border border-border bg-surface p-5">
        <h2 className="text-xs font-bold uppercase tracking-widest text-muted">Données</h2>
        <Row
          title="Historique de lecture"
          hint={lastWatched.length > 0 ? `${lastWatched.length} chaîne${lastWatched.length > 1 ? 's' : ''} mémorisée${lastWatched.length > 1 ? 's' : ''} pour « Reprendre ».` : 'Aucune chaîne mémorisée.'}
        >
          <button
            type="button"
            onClick={clearLastWatched}
            disabled={lastWatched.length === 0}
            className="shrink-0 rounded-xl border border-border px-3.5 py-2 text-xs font-bold text-muted transition hover:bg-surface-2 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            Effacer
          </button>
        </Row>

        <Row
          title="Cache de l'application"
          hint="Purge le service worker et les fichiers mis en cache (pages, icônes), puis recharge. À utiliser si l'app semble bloquée sur une ancienne version."
        >
          <button
            type="button"
            onClick={() => void clearAppCache()}
            disabled={clearing}
            className="shrink-0 rounded-xl border border-border px-3.5 py-2 text-xs font-bold text-muted transition hover:bg-surface-2 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            {clearing ? 'Purge…' : 'Vider le cache'}
          </button>
        </Row>
      </section>
    </main>
  );
}
