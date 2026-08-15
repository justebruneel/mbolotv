'use client';

import { useEffect } from 'react';
import { useRemindersStore, type RemindersState } from '../../../shared/stores/reminders';

export function useReminderScheduler(): void {
  const reminders = useRemindersStore((state: RemindersState) => state.reminders);
  const markFired = useRemindersStore((state: RemindersState) => state.markFired);

  useEffect(() => {
    const check = (): void => {
      const now = Date.now();
      for (const reminder of reminders) {
        if (reminder.fired) continue;
        const start = new Date(reminder.startsAt).getTime();
        if (start <= now && now - start < 5 * 60_000) {
          if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            try {
              new Notification(reminder.title, {
                body: `${reminder.channelName} — commence maintenant`,
              });
            } catch {
              // notification non disponible : on marque quand même comme traité
            }
          }
          markFired(reminder.programmeId);
        }
      }
    };
    check();
    const interval = setInterval(check, 15_000);
    return () => clearInterval(interval);
  }, [reminders, markFired]);
}
