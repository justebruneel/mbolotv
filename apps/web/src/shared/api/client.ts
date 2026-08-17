const baseUrl = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');
const API_URL = baseUrl.endsWith('/api') ? baseUrl : `${baseUrl}/api`;

export type QueryParams = Record<string, string | number | undefined>;

export async function apiGet<T>(path: string, params?: QueryParams): Promise<T> {
  const search = params
    ? new URLSearchParams(
        Object.entries(params)
          .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
          .map(([key, value]) => [key, String(value)]),
      ).toString()
    : '';
  const response = await fetch(`${API_URL}${path}${search ? `?${search}` : ''}`, {
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`API ${response.status} sur ${path}`);
  }
  return (await response.json()) as T;
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`API ${response.status} sur ${path}`);
  }
  return (await response.json()) as T;
}
