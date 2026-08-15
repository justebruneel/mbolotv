'use client';

import type { Channel } from '@mbolo/contracts';
import { ReactNode, useState } from 'react';
import styles from './ChannelCard.module.css';

export interface ChannelCardProps {
  channel: Channel;
  actions?: ReactNode;
  onClick?: () => void;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

export function ChannelCard({ channel, actions, onClick }: ChannelCardProps) {
  const [logoError, setLogoError] = useState(false);
  const down = channel.healthStatus === 'DOWN';
  return (
    <article className={down ? [styles.card, styles.down].join(' ') : styles.card}>
      {onClick && !down && (
        <a className={styles.overlay} href="#" onClick={(event) => {
          event.preventDefault();
          onClick();
        }} aria-label={channel.name} />
      )}
      {actions && <div className={styles.actions}>{actions}</div>}
      <div className={styles.logo} aria-hidden>
        {channel.logoUrl && !logoError ? (
          <img
            src={channel.logoUrl}
            alt=""
            width={56}
            height={56}
            decoding="async"
            onError={() => setLogoError(true)}
            style={{ objectFit: 'contain' }}
          />
        ) : (
          initials(channel.name)
        )}
      </div>
      <h3 className={styles.name}>{channel.name}</h3>
      <div className={styles.meta}>
        {channel.country && <span className={styles.country}>{channel.country}</span>}
      </div>
      {down ? (
        <p className={styles.now}>
          <strong>Hors ligne</strong>
        </p>
      ) : (
        channel.nowPlaying && (
          <p className={styles.now}>
            <strong>{formatTime(channel.nowPlaying.startsAt)}</strong> · {channel.nowPlaying.title}
          </p>
        )
      )}
    </article>
  );
}
