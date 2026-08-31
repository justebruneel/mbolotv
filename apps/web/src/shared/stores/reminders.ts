'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { apiDelete, apiPost } from '../api/client';
import { sharedQueryClient } from '../components/QueryProvider';

export interface Reminder {
  programmeId: string;
  channelId: string;
  channelName: string;
  title: string;
  startsAt: string;
  endsAt: string;
  fired: boolean;
}

interface RemindersState {
  reminders: Reminder[];
  /** true après la première synchronisation serveur : ensuite le serveur
   * fait foi (sinon les suppressions faites ailleurs ressusciteraient). */
  synced: boolean;
  add: (reminder: Reminder) => void;
  remove: (programmeId: string) => void;
  markFired: (programmeId: string) => void;
  has: (programmeId: string) => boolean;
  /** Importe la liste serveur ; au premier passage, les rappels locaux
   * (localStorage) inconnus du serveur y sont poussés (migration). */
  syncFromServer: (serverReminders: Reminder[]) => void;
}

export type { RemindersState };

function invalidateReminders(): void {
  void sharedQueryClient?.invalidateQueries({ queryKey: ['reminders'] });
}

function toPayload(reminder: Reminder): Record<string, string> {
  return {
    programmeId: reminder.programmeId,
    channelId: reminder.channelId,
    channelName: reminder.channelName,
    title: reminder.title,
    startsAt: reminder.startsAt,
    endsAt: reminder.endsAt,
  };
}

const byStart = (a: Reminder, b: Reminder): number => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime();

export const useRemindersStore = create<RemindersState>()(
  persist(
    (set, get) => ({
      reminders: [],
      synced: false,
      add: (reminder) => {
        if (get().has(reminder.programmeId)) return;
        const previous = get().reminders;
        // Optimiste : l'UI réagit instantanément, le serveur confirme en fond.
        set({ reminders: [...previous, reminder].sort(byStart) });
        void apiPost('/reminders', toPayload(reminder))
          .then(invalidateReminders)
          .catch(() => {
            set({ reminders: previous });
            invalidateReminders();
          });
      },
      remove: (programmeId) => {
        const previous = get().reminders;
        set({ reminders: previous.filter((reminder) => reminder.programmeId !== programmeId) });
        void apiDelete(`/reminders/${encodeURIComponent(programmeId)}`)
          .then(invalidateReminders)
          .catch(() => {
            set({ reminders: previous });
            invalidateReminders();
          });
      },
      markFired: (programmeId) =>
        set((state) => ({
          reminders: state.reminders.map((reminder) =>
            reminder.programmeId === programmeId ? { ...reminder, fired: true } : reminder,
          ),
        })),
      has: (programmeId) => get().reminders.some((reminder) => reminder.programmeId === programmeId),
      syncFromServer: (serverReminders) => {
        const local = get().reminders;
        if (!get().synced) {
          const serverIds = new Set(serverReminders.map((reminder) => reminder.programmeId));
          const missing = local.filter((reminder) => !serverIds.has(reminder.programmeId) && reminder.endsAt);
          missing.forEach((reminder) => void apiPost('/reminders', toPayload(reminder)).catch(() => undefined));
          set({ reminders: [...serverReminders, ...missing].sort(byStart), synced: true });
          return;
        }
        set({ reminders: serverReminders });
      },
    }),
    { name: 'mbolo-reminders' },
  ),
);
