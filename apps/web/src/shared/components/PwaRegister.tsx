'use client';

import { useEffect } from 'react';

export function PwaRegister() {
  useEffect(() => {
    // Jamais en dev : le SW mettrait en cache des chunks /_next/static recompilés
    // (cache-first) et masquerait chaque modification de code.
    if (process.env.NODE_ENV !== 'production') return;
    if ('serviceWorker' in navigator && window.isSecureContext) void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  }, []);
  return null;
}
