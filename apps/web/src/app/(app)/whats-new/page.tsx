'use client';

import type { AnnouncementKind } from '@mbolo/contracts';
import { Icon, Skeleton } from '@mbolo/ui';
import { useEffect, useRef, useState } from 'react';
import { useAnnouncements } from '../../../shared/api/queries';
import { useWhatsNewStore } from '../../../shared/stores/whatsNew';

const KIND_TONE: Record<AnnouncementKind, string> = {
  INFO: 'bg-surface-2 text-secondary',
  VERSION: 'bg-accent/15 text-accent',
  PROMO: 'bg-danger/15 text-danger',
};

const KIND_LABEL: Record<AnnouncementKind, string> = {
  INFO: 'Information',
  VERSION: 'Nouvelle version',
  PROMO: 'Promotion',
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
}

export default function WhatsNewPage() {
  const announcementsQuery = useAnnouncements();
  const items = announcementsQuery.data?.items ?? [];
  // Repère de lecture partagé avec les badges du menu : on capture la valeur
  // AVANT de la recaler sur la plus récente annonce (sinon plus de « Nouveau »).
  const lastReadAt = useWhatsNewStore((state) => state.lastReadAt);
  const markRead = useWhatsNewStore((state) => state.markRead);
  const [previousRead, setPreviousRead] = useState<string | null | undefined>(undefined);
  const capturedRef = useRef(false);

  useEffect(() => {
    if (capturedRef.current || items.length === 0) return;
    capturedRef.current = true;
    setPreviousRead(lastReadAt);
    markRead(items[0].createdAt);
  }, [items, lastReadAt, markRead]);

  return (
    <main className="mx-auto max-w-2xl animate-fade-in px-4 py-6 md:px-10">
      <h1 className="text-2xl font-black tracking-tight md:text-3xl">Quoi de neuf</h1>
      <p className="mt-1 text-sm text-muted">Les annonces de l’équipe Mbolo TV : versions, promotions, services.</p>

      {announcementsQuery.isLoading && (
        <div className="mt-6 flex flex-col gap-4">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-28 w-full rounded-2xl" />
          ))}
        </div>
      )}

      {!announcementsQuery.isLoading && items.length === 0 && (
        <div className="mx-auto max-w-md py-16 text-center">
          <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-2xl bg-surface-2">
            <Icon.Bell size={36} className="text-muted" />
          </div>
          <h2 className="text-xl font-bold">Rien de neuf pour l’instant</h2>
          <p className="mt-2 text-sm text-muted">Tu verras ici les annonces de l’équipe dès qu’elles seront publiées.</p>
        </div>
      )}

      {items.length > 0 && (
        <ul className="mt-6 flex flex-col gap-4">
          {items.map((item) => {
            const unread = previousRead !== undefined && (previousRead === null || item.createdAt > previousRead);
            return (
              <li key={item.id} className={`rounded-2xl border bg-surface p-5 ${unread ? 'border-accent/50 shadow-md shadow-accent/10' : 'border-border'}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${KIND_TONE[item.kind]}`}>{KIND_LABEL[item.kind]}</span>
                  {unread && <span className="rounded-full bg-accent px-2 py-0.5 text-[9px] font-black uppercase tracking-widest text-on-accent">Nouveau</span>}
                  <span className="ml-auto text-xs text-faint">{formatDate(item.createdAt)}</span>
                </div>
                <h2 className="mt-2.5 text-base font-extrabold leading-tight">{item.title}</h2>
                <p className="mt-1.5 text-sm leading-relaxed text-secondary">{item.body}</p>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
