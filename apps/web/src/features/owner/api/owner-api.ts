import type {
  AuditEntry,
  ConnectTestResponse,
  ImportRun,
  ImportRunListResponse,
  Overview,
  OwnerLoginInput,
  OwnerMe,
  SourceCreateInput,
  SourceDetail,
  SourceResponse,
  SourceUpdateInput,
} from '@mbolo/contracts';

// Même origine que le web : les appels passent par le proxy Next.js (rewrite
// /api/owner/*), qui pose le cookie de session sur le domaine du web. Cela
// évite les blocages de cookies en contexte cross-site (Vercel -> Render).
export const BASE_URL = '/api';

export type ApiError = { error: string; message?: string };

const JSON_HEADERS: Record<string, string> = { 'content-type': 'application/json' };

async function parseResponse<T>(response: Response): Promise<T> {
  if (response.ok) return (response.status === 204 ? null : response.json()) as T;
  let body: ApiError = { error: 'Erreur inconnue' };
  try {
    body = (await response.json()) as ApiError;
  } catch {
    body = { error: `HTTP ${response.status}` };
  }
  const err = new Error(body.message ?? body.error) as Error & { status: number; body: ApiError };
  err.status = response.status;
  err.body = body;
  throw err;
}

export const ownerApi = {
  auth: {
    login: (input: OwnerLoginInput): Promise<OwnerMe> =>
      fetch(`${BASE_URL}/owner/auth/login`, {
        method: 'POST',
        credentials: 'include',
        headers: JSON_HEADERS,
        body: JSON.stringify(input),
      }).then(parseResponse<OwnerMe>),

    logout: (): Promise<void> =>
      fetch(`${BASE_URL}/owner/auth/logout`, {
        method: 'POST',
        credentials: 'include',
      }).then(parseResponse<void>),
  },

  overview: (): Promise<Overview> =>
    fetch(`${BASE_URL}/owner/overview`, { credentials: 'include' }).then(
      parseResponse<Overview>,
    ),

  audit: (limit = 50, offset = 0): Promise<{ items: AuditEntry[]; total: number }> =>
    fetch(`${BASE_URL}/owner/audit?limit=${limit}&offset=${offset}`, {
      credentials: 'include',
    }).then(parseResponse<{ items: AuditEntry[]; total: number }>),

  sources: {
    list: (): Promise<SourceResponse[]> =>
      fetch(`${BASE_URL}/owner/sources`, { credentials: 'include' }).then(
        parseResponse<SourceResponse[]>,
      ),

    detail: (id: string): Promise<SourceDetail> =>
      fetch(`${BASE_URL}/owner/sources/${id}`, { credentials: 'include' }).then(
        parseResponse<SourceDetail>,
      ),

    create: (input: SourceCreateInput): Promise<SourceResponse> =>
      fetch(`${BASE_URL}/owner/sources`, {
        method: 'POST',
        credentials: 'include',
        headers: JSON_HEADERS,
        body: JSON.stringify(input),
      }).then(parseResponse<SourceResponse>),

    update: (id: string, input: SourceUpdateInput): Promise<SourceResponse> =>
      fetch(`${BASE_URL}/owner/sources/${id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: JSON_HEADERS,
        body: JSON.stringify(input),
      }).then(parseResponse<SourceResponse>),

    remove: (id: string): Promise<void> =>
      fetch(`${BASE_URL}/owner/sources/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      }).then(parseResponse<void>),

    test: (id: string): Promise<ConnectTestResponse> =>
      fetch(`${BASE_URL}/owner/sources/${id}/test`, { credentials: 'include' }).then(
        parseResponse<ConnectTestResponse>,
      ),

    import: (id: string): Promise<ImportRun> =>
      fetch(`${BASE_URL}/owner/sources/${id}/import`, {
        method: 'POST',
        credentials: 'include',
      }).then(parseResponse<ImportRun>),

    uploadPlaylist: (id: string, file: File): Promise<SourceResponse> =>
      fetch(`${BASE_URL}/owner/sources/${id}/playlist`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/octet-stream' },
        body: file,
      }).then(parseResponse<SourceResponse>),
  },

  imports: {
    list: (): Promise<ImportRunListResponse> =>
      fetch(`${BASE_URL}/owner/imports`, { credentials: 'include' }).then(
        parseResponse<ImportRunListResponse>,
      ),

    detail: (id: string): Promise<ImportRun> =>
      fetch(`${BASE_URL}/owner/imports/${id}`, { credentials: 'include' }).then(
        parseResponse<ImportRun>,
      ),
  },
};