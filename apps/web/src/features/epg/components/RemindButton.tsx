'use client';

import { Icon } from '@mbolo/ui';
import { useRemindersStore } from '../../../shared/stores/reminders';
import { usePush } from '../../../shared/hooks/usePush';

export interface RemindTarget {
  id: string;
  channelId: string;
  channelName: string;
  title: string;
  startsAt: string;
  endsAt: string;
}

export function RemindButton({ programme }: { programme: RemindTarget }) {
  const has = useRemindersStore((state) => state.has);
  const add = useRemindersStore((state) => state.add);
  const remove = useRemindersStore((state) => state.remove);
  const { enable } = usePush();
  const active = has(programme.id);

  const onClick = async (): Promise<void> => {
    if (active) {
      remove(programme.id);
      return;
    }
    // Un premier rappel tente l'activation du push (permission + abonnement) :
    // c'est le geste utilisateur qu'iOS exige. S'il échoue (refus, app non
    // installée), le rappel reste enregistré et le scheduler local prend le
    // relais quand l'app est ouverte.
    await enable().catch(() => false);
    add({
      programmeId: programme.id,
      channelId: programme.channelId,
      channelName: programme.channelName,
      title: programme.title,
      startsAt: programme.startsAt,
      endsAt: programme.endsAt,
      fired: false,
    });
  };

  return (
    <button
      type="button"
      onClick={onClick}
      className={
        active
          ? 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-accent/15 text-accent hover:bg-accent/25 transition-colors'
          : 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-surface-2 text-muted hover:bg-surface-3 hover:text-foreground transition-colors'
      }
    >
      {active ? <Icon.Check size={13} /> : <Icon.Bell size={13} />}
      {active ? 'Rappelé' : 'Rappeler'}
    </button>
  );
}
