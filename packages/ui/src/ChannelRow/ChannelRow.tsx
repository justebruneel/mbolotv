import type { Channel, Programme } from '@mbolo/contracts';
import { Badge } from '../Badge/Badge';
import styles from './ChannelRow.module.css';

export interface ChannelRowProps {
  channel: Channel;
  now: Programme | null;
  next: Programme | null;
  onClick?: () => void;
}

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

export function ChannelRow({ channel, now, next, onClick }: ChannelRowProps) {
  return (
    <a
      className={styles.row}
      href="#"
      onClick={(event) => {
        event.preventDefault();
        onClick?.();
      }}
    >
      <span className={styles.avatar}>
        {channel.logoUrl ? (
          <img src={channel.logoUrl} alt="" width={40} height={40} style={{ objectFit: 'contain' }} />
        ) : (
          channel.name.charAt(0)
        )}
      </span>
      <span className={styles.info}>
        <p className={styles.name}>{channel.name}</p>
        <span className={styles.epg}>
          {now ? (
            <span className={styles.item}>
              <Badge tone="danger" live>
                En ce moment
              </Badge>
              {' '}
              <span className={styles.liveTitle}>{now.title}</span> · {time(now.startsAt)}
            </span>
          ) : null}
          {next ? (
            <span className={styles.item}>
              Suivant : {next.title} · {time(next.startsAt)}
            </span>
          ) : null}
        </span>
      </span>
    </a>
  );
}
