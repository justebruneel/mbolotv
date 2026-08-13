import { cookies } from 'next/headers';

export type VerifiedOwnerSession = {
  userId: string;
  role: 'OWNER';
  mfaVerifiedAt: Date;
  expiresAt: Date;
};

const API_URL = process.env.API_URL ?? 'http://localhost:4000';

export async function getVerifiedOwnerSession(): Promise<VerifiedOwnerSession | null> {
  const store = await cookies();
  const token = store.get('mbolo_owner_session');
  if (!token) return null;

  try {
    const response = await fetch(`${API_URL}/api/owner/auth/session`, {
      headers: { cookie: `mbolo_owner_session=${token.value}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return null;
    const session = (await response.json()) as {
      me: { id: string; role: string; email: string };
      sessionId: string;
      mfaVerifiedAt?: string;
      expiresAt?: string;
    };
    if (session.me.role !== 'OWNER') return null;
    return {
      userId: session.me.id,
      role: 'OWNER',
      mfaVerifiedAt: session.mfaVerifiedAt ? new Date(session.mfaVerifiedAt) : new Date(),
      expiresAt: session.expiresAt ? new Date(session.expiresAt) : new Date(Date.now() + 60_000),
    };
  } catch {
    return null;
  }
}

/**
 * Fetch serveur vers l'API en relayant le cookie de session owner.
 * À utiliser dans les pages console (server components).
 */
export async function serverOwnerFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const store = await cookies();
  const token = store.get('mbolo_owner_session');
  if (!token) throw new Error('Session manquante');

  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      cookie: `mbolo_owner_session=${token.value}`,
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string; error?: string } | null;
    throw new Error(body?.message ?? body?.error ?? `HTTP ${response.status}`);
  }
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}