'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface Reminder {
  programmeId: string;
  channelId: string;
  channelName: string;
  title: string;
  startsAt: string;
  fired: boolean;
}

interface RemindersState {
  reminders: Reminder[];
  add: (reminder: Reminder) => void;
  remove: (programmeId: string) => void;
  markFired: (programmeId: string) => void;
  has: (programmeId: string) => boolean;
}

export type { RemindersState };

export const useRemindersStore = create<RemindersState>()(
  persist(
    (set, get) => ({
      reminders: [],
      add: (reminder) => {
        if (get().has(reminder.programmeId)) return;
        set((state) => ({
          reminders: [...state.reminders, reminder].sort(
            (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
          ),
        }));
      },
      remove: (programmeId) =>
        set((state) => ({
          reminders: state.reminders.filter((reminder) => reminder.programmeId !== programmeId),
        })),
      markFired: (programmeId) =>
        set((state) => ({
          reminders: state.reminders.map((reminder) =>
            reminder.programmeId === programmeId ? { ...reminder, fired: true } : reminder,
          ),
        })),
      has: (programmeId) => get().reminders.some((reminder) => reminder.programmeId === programmeId),
    }),
    {
      name: 'mbolo-reminders',
    },
  ),
);
