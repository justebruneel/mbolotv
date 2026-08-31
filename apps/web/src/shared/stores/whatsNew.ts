'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface WhatsNewState {
  /** Horodatage de la dernière annonce lue (repère des « Nouveau »). */
  lastReadAt: string | null;
  markRead: (newestIso: string) => void;
}

/** État partagé entre la page « Quoi de neuf » et les badges du menu. */
export const useWhatsNewStore = create<WhatsNewState>()(
  persist(
    (set) => ({
      lastReadAt: null,
      markRead: (newestIso) => set({ lastReadAt: newestIso }),
    }),
    { name: 'mbolo-whats-new' },
  ),
);
