const baseUrl = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');
const API_URL = baseUrl.endsWith('/api') ? baseUrl : `${baseUrl}/api`;
const DEVICE_KEY = 'mbolo:device-id';

export type QueryParams = Record<string, string | number | undefined>;

export class ApiError extends Error {
  readonly status: number;
  readonly path: string;
  readonly details: unknown;

  constructor(status: number, path: string, details?: unknown) {
    const message = typeof details === 'object' && details !== null && 'message' in details
      ? String((details as { message?: unknown }).message)
      : `API ${status} sur ${path}`;
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.path = path;
    this.details = details;
  }
}

function deviceId(): string {
  if (typeof window === 'undefined') return '';
  const existing = window.localStorage.getItem(DEVICE_KEY);
  if (existing) return existing;
  const created = typeof window.crypto?.randomUUID === 'function'
    ? window.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  window.localStorage.setItem(DEVICE_KEY, created);
  return created;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function readError(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { return undefined; }
}

async function request<T>(path: string, init: RequestInit, retryGet: boolean): Promise<T> {
  const attempts = retryGet ? 3 : 1;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`${API_URL}${path}`, { ...init, headers: { ...(init.headers ?? {}), 'x-device-id': deviceId() }, cache: 'no-store' });
      if (response.ok) return (await response.json()) as T;
      const details = await readError(response);
      if (retryGet && response.status >= 500 && attempt + 1 < attempts) {
        await delay(250 * 2 ** attempt);
        continue;
      }
      throw new ApiError(response.status, path, details);
    } catch (error) {
      lastError = error;
      if (error instanceof ApiError || !retryGet || attempt + 1 >= attempts) throw error;
      await delay(250 * 2 ** attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Échec API sur ${path}`);
}

export async function apiGet<T>(path: string, params?: QueryParams): Promise<T> {
  const search = params
    ? new URLSearchParams(Object.entries(params).filter((entry): entry is [string, string | number] => entry[1] !== undefined).map(([key, value]) => [key, String(value)])).toString()
    : '';
  return request<T>(`${path}${search ? `?${search}` : ''}`, { method: 'GET' }, true);
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, false);
}
