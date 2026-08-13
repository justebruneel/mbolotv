const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api';

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
