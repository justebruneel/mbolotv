'use client';

import { useEffect, useRef } from 'react';
import type { EpgEntry, Programme } from '@mbolo/contracts';
import styles from './EpgGrid.module.css';

export interface EpgGridProps {
  entries: EpgEntry[];
  from: Date;
  to: Date;
  onSelectChannel?: (channelId: string) => void;
  onSelectProgramme?: (programme: Programme) => void;
}

const PX_PER_HOUR = 150;

export function EpgGrid({ entries, from, to, onSelectChannel, onSelectProgramme }: EpgGridProps) {
  const windowMs = to.getTime() - from.getTime();
  const totalWidth = Math.max(600, (windowMs / 3_600_000) * PX_PER_HOUR);
  const now = Date.now();
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  // À l'ouverture, on amène le curseur « maintenant » en vue (avec une
  // avance de 90 min) au lieu de débarquer sur le début de la journée.
  const fromMs = from.getTime();
  const toMs = to.getTime();
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const current = Date.now();
    if (current < fromMs || current > toMs) return;
    const ratio = (current - fromMs) / (toMs - fromMs);
    el.scrollLeft = Math.max(0, ratio * totalWidth - 240);
  }, [fromMs, toMs, totalWidth]);

  const hours: Date[] = [];
  for (let t = from.getTime(); t < to.getTime(); t += 3_600_000) {
    hours.push(new Date(t));
  }

  const leftOf = (iso: string): number => {
    const ratio = (new Date(iso).getTime() - from.getTime()) / windowMs;
    return Math.max(0, Math.min(1, ratio)) * totalWidth;
  };
  const widthOf = (startIso: string, endIso: string): number => {
    return leftOf(endIso) - leftOf(startIso);
  };
  const isLive = (programme: Programme): boolean =>
    new Date(programme.startsAt).getTime() <= now && new Date(programme.endsAt).getTime() > now;

  return (
    <div className={styles.grid}>
      <div className={styles.scroller} ref={scrollerRef}>
        <div className={styles.timeline} style={{ width: totalWidth + 240 }}>
          <div className={styles.header}>
            <div className={styles.channelHead}>Chaînes</div>
            <div className={styles.axis} style={{ width: totalWidth }}>
              {hours.map((hour) => (
                <span
                  key={hour.getTime()}
                  className={styles.hourMark}
                  style={{ left: ((hour.getTime() - from.getTime()) / windowMs) * totalWidth }}
                >
                  {hour.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}
                </span>
              ))}
            </div>
          </div>
          {entries.map((entry) => (
            <div key={entry.channel.id} className={styles.row}>
              <button
                type="button"
                className={styles.channelCell}
                onClick={() => onSelectChannel?.(entry.channel.id)}
              >
                <span className={styles.avatar}>
                  {entry.channel.logoUrl ? (
                    <img src={entry.channel.logoUrl} alt="" width={28} height={28} style={{ objectFit: 'contain' }} />
                  ) : (
                    entry.channel.name.charAt(0)
                  )}
                </span>
                {entry.channel.name}
              </button>
              <div className={styles.track} style={{ width: totalWidth }}>
                {entry.programmes.map((programme) => {
                  const left = leftOf(programme.startsAt);
                  const width = widthOf(programme.startsAt, programme.endsAt);
                  if (width <= 0) return null;
                  const live = isLive(programme);
                  return (
                    <button
                      type="button"
                      key={programme.id}
                      className={[styles.block, live ? styles.live : ''].filter(Boolean).join(' ')}
                      style={{ left, width }}
                      onClick={() => onSelectProgramme?.(programme)}
                      title={programme.title}
                    >
                      <div className={styles.title}>{programme.title}</div>
                      <div className={styles.time}>
                        {new Date(programme.startsAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}
                        {' – '}
                        {new Date(programme.endsAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}
                      </div>
                    </button>
                  );
                })}
                {now >= from.getTime() && now <= to.getTime() && (
                  <div
                    className={styles.nowLine}
                    style={{ left: ((now - from.getTime()) / windowMs) * totalWidth }}
                  />
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
