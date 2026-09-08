'use client';

import { useEffect } from 'react';

export function PwaRegister() {
  useEffect(() => {
    // Jamais en dev : le SW mettrait en cache des chunks /_next/static recompilés
    // (cache-first) et masquerait chaque modification de code.
    if (process.env.NODE_ENV !== 'production') return;
    if ('serviceWorker' in navigator && window.isSecureContext) void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  }, []);

  useEffect(() => {
    // PWA installée (iPhone) : neutraliser le swipe « avant » tout en
    // gardant le swipe « arrière » natif. Le geste système n'est pas
    // annulable côté page — on tague donc chaque entrée d'historique d'un
    // index croissant (patch de pushState/replaceState, transparent pour
    // Next.js dont l'état est préservé) et on reconnaît au popstate un
    // commit « avant » (index qui AUGMENTE, comme le swipe forward iOS) :
    // il est aussitôt annulé par un retour à l'entrée d'origine. Le swipe
    // back (index qui diminue) passe sans être touché.
    const standalone = window.matchMedia('(display-mode: standalone)').matches
      || (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
    if (!standalone) return;

    const nativePush = History.prototype.pushState;
    const nativeReplace = History.prototype.replaceState;
    const indexOf = (state: unknown): number => {
      const idx = (state as { __mboloIdx?: unknown } | null)?.__mboloIdx;
      return typeof idx === 'number' ? idx : 0;
    };
    History.prototype.pushState = function pushStatePatched(this: History, data: unknown, unused: string, url?: string | URL): void {
      nativePush.call(this, { ...((data as Record<string, unknown> | null) ?? {}), __mboloIdx: indexOf(this.state) + 1 }, unused, url);
    };
    History.prototype.replaceState = function replaceStatePatched(this: History, data: unknown, unused: string, url?: string | URL): void {
      nativeReplace.call(this, { ...((data as Record<string, unknown> | null) ?? {}), __mboloIdx: indexOf(this.state) }, unused, url);
    };
    nativeReplace.call(history, { ...((history.state as Record<string, unknown> | null) ?? {}), __mboloIdx: 0 }, '', location.href);

    let current = 0;
    const onPop = (event: PopStateEvent): void => {
      const next = indexOf(event.state);
      if (next > current) {
        // Commit « avant » (swipe forward) : annulé — retour immédiat à
        // l'entrée d'origine ; le popstate du go() re-synchronisera current.
        history.go(current - next);
        return;
      }
      current = next;
    };
    window.addEventListener('popstate', onPop);
    return () => {
      History.prototype.pushState = nativePush;
      History.prototype.replaceState = nativeReplace;
      window.removeEventListener('popstate', onPop);
    };
  }, []);

  return null;
}
