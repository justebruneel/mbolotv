'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiDelete, apiPost } from '../api/client';

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY as string | undefined;

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = window.atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

export type PushState = 'unsupported' | 'no-vapid' | 'prompt' | 'denied' | 'subscribed';

/**
 * Abonnement Web Push : permission système + pushManager via le service
 * worker, endpoint enregistré côté serveur (par appareil). Sur iOS, le push
 * n'existe que depuis le PWA installé (≥ 16.4) — `standalone` l'indique.
 */
export function usePush(): { state: PushState; standalone: boolean; enable: () => Promise<boolean>; disable: () => Promise<void> } {
  const [state, setState] = useState<PushState>('unsupported');
  const [standalone, setStandalone] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window) || typeof Notification === 'undefined') {
      setState('unsupported');
      return;
    }
    if (!VAPID_PUBLIC_KEY) {
      setState('no-vapid');
      return;
    }
    if (Notification.permission === 'denied') {
      setState('denied');
      return;
    }
    if (Notification.permission !== 'granted') {
      setState('prompt');
      return;
    }
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    setState(subscription ? 'subscribed' : 'prompt');
  }, []);

  useEffect(() => {
    setStandalone(
      window.matchMedia('(display-mode: standalone)').matches ||
        (window.navigator as Navigator & { standalone?: boolean }).standalone === true,
    );
    void refresh();
  }, [refresh]);

  const enable = useCallback(async (): Promise<boolean> => {
    if (!VAPID_PUBLIC_KEY || !('serviceWorker' in navigator) || !('PushManager' in window)) return false;
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      void refresh();
      return false;
    }
    try {
      const registration = await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        });
      }
      const json = subscription.toJSON();
      await apiPost('/push/subscribe', { endpoint: json.endpoint, keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' } });
      void refresh();
      return true;
    } catch {
      void refresh();
      return false;
    }
  }, [refresh]);

  const disable = useCallback(async (): Promise<void> => {
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      await subscription?.unsubscribe().catch(() => undefined);
      await apiDelete('/push/subscribe').catch(() => undefined);
    } finally {
      void refresh();
    }
  }, [refresh]);

  return { state, standalone, enable, disable };
}
