'use client';

import { useEffect } from 'react';

/**
 * Comportement natif face au clavier virtuel (PWA iOS surtout) : sur iOS,
 * les éléments `position: fixed; bottom: 0` s'ancrent au bas de la VISUAL
 * viewport et « montent » avec le clavier. Ce hook mesure l'écart entre le
 * bas du layout viewport et le bas de la visual viewport (l'API
 * visualViewport) et le publie dans la variable CSS `--kb-offset` sur
 * :root. Les barres fixed (onglets bas, mini-lecteur) se recalelent avec
 * `translateY(var(--kb-offset))` : elles restent fixées en bas de la page
 * et le clavier passe simplement par-dessus.
 *
 * Sur Android/Chrome, layout et visual viewports coïncident — l'écart est
 * nul, le hook est sans effet. Sans visualViewport (vieux navigateurs),
 * aucun recalage : comportement historique.
 */
export function useKeyboardViewportOffset(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    const update = (): void => {
      const offset = Math.max(0, Math.round(window.innerHeight - (viewport.height + viewport.offsetTop)));
      if (offset > 0) {
        document.documentElement.style.setProperty('--kb-offset', `${offset}px`);
      } else {
        document.documentElement.style.removeProperty('--kb-offset');
      }
    };

    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    window.addEventListener('orientationchange', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
      window.removeEventListener('orientationchange', update);
      document.documentElement.style.removeProperty('--kb-offset');
    };
  }, []);
}
