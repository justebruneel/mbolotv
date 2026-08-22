import type {
  AccessCode,
  AccessCodeCreateInput,
  AuditEntry,
  ChannelTestResponse,
  ConnectTestResponse,
  ImportRun,
  ImportRunListResponse,
  Overview,
  OwnerCatalog,
  OwnerCategoryCreateInput,
  OwnerCategoryUpdateInput,
  OwnerChannelUpdateInput,
  OwnerLoginInput,
  OwnerMe,
  OwnerProfile,
  OwnerProfileUpdateInput,
  SourceCreateInput,
  SourceCredentials,
  SourceDetail,
  SourceResponse,
  SourceUpdateInput,
} from '@mbolo/contracts';

export const BASE_URL = '/api';
export type ApiError = { error: string; message?: string };
const JSON_HEADERS: Record<string, string> = { 'content-type': 'application/json' };
const AUTH_TIMEOUT_MS = 15_000;

async function parseResponse<T>(response: Response): Promise<T> {
  if (response.ok) return (response.status === 204 ? null : response.json()) as T;
  let body: ApiError = { error: 'Erreur inconnue' };
  try { body = (await response.json()) as ApiError; } catch { body = { error: `HTTP ${response.status}` }; }
  const err = new Error(body.message ?? body.error) as Error & { status: number; body: ApiError };
  err.status = response.status; err.body = body; throw err;
}

export const ownerApi = {
  auth: {
    login: (input: OwnerLoginInput): Promise<OwnerMe> => {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), AUTH_TIMEOUT_MS);
      return fetch(`${BASE_URL}/owner/auth/login`, { method: 'POST', credentials: 'include', headers: JSON_HEADERS, body: JSON.stringify(input), signal: controller.signal }).then(parseResponse<OwnerMe>).finally(() => window.clearTimeout(timer));
    },
    logout: (): Promise<void> => fetch(`${BASE_URL}/owner/auth/logout`, { method: 'POST', credentials: 'include' }).then(parseResponse<void>),
  },
  overview: (): Promise<Overview> => fetch(`${BASE_URL}/owner/overview`, { credentials: 'include' }).then(parseResponse<Overview>),
  audit: (limit = 50, offset = 0): Promise<{ items: AuditEntry[]; total: number }> => fetch(`${BASE_URL}/owner/audit?limit=${limit}&offset=${offset}`, { credentials: 'include' }).then(parseResponse<{ items: AuditEntry[]; total: number }>),
  catalog: (): Promise<OwnerCatalog> => fetch(`${BASE_URL}/owner/catalog`, { credentials: 'include' }).then(parseResponse<OwnerCatalog>),
  categories: {
    create: (input: OwnerCategoryCreateInput): Promise<OwnerCatalog> => fetch(`${BASE_URL}/owner/categories`, { method: 'POST', credentials: 'include', headers: JSON_HEADERS, body: JSON.stringify(input) }).then(parseResponse<OwnerCatalog>),
    update: (id: string, input: OwnerCategoryUpdateInput): Promise<OwnerCatalog> => fetch(`${BASE_URL}/owner/categories/${id}`, { method: 'PATCH', credentials: 'include', headers: JSON_HEADERS, body: JSON.stringify(input) }).then(parseResponse<OwnerCatalog>),
  },
  profile: (): Promise<OwnerProfile> => fetch(`${BASE_URL}/owner/profile`, { credentials: 'include' }).then(parseResponse<OwnerProfile>),
  profileUpdate: (input: OwnerProfileUpdateInput): Promise<OwnerProfile> => fetch(`${BASE_URL}/owner/profile`, { method: 'PATCH', credentials: 'include', headers: JSON_HEADERS, body: JSON.stringify(input) }).then(parseResponse<OwnerProfile>),
  channels: {
    update: (id: string, input: OwnerChannelUpdateInput): Promise<OwnerCatalog> => fetch(`${BASE_URL}/owner/channels/${id}`, { method: 'PATCH', credentials: 'include', headers: JSON_HEADERS, body: JSON.stringify(input) }).then(parseResponse<OwnerCatalog>),
    test: (id: string): Promise<ChannelTestResponse> => fetch(`${BASE_URL}/owner/channels/${id}/test`, { method: 'POST', credentials: 'include' }).then(parseResponse<ChannelTestResponse>),
  },
  accessCodes: {
    list: (): Promise<AccessCode[]> => fetch(`${BASE_URL}/owner/access-codes`, { credentials: 'include' }).then(parseResponse<AccessCode[]>),
    create: (input: AccessCodeCreateInput): Promise<AccessCode> => fetch(`${BASE_URL}/owner/access-codes`, { method: 'POST', credentials: 'include', headers: JSON_HEADERS, body: JSON.stringify(input) }).then(parseResponse<AccessCode>),
    revoke: (id: string): Promise<void> => fetch(`${BASE_URL}/owner/access-codes/${id}`, { method: 'DELETE', credentials: 'include' }).then(parseResponse<void>),
  },
  sources: {
    list: (): Promise<SourceResponse[]> => fetch(`${BASE_URL}/owner/sources`, { credentials: 'include' }).then(parseResponse<SourceResponse[]>),
    detail: (id: string): Promise<SourceDetail> => fetch(`${BASE_URL}/owner/sources/${id}`, { credentials: 'include' }).then(parseResponse<SourceDetail>),
    credentials: (id: string): Promise<SourceCredentials> => fetch(`${BASE_URL}/owner/sources/${id}/credentials`, { credentials: 'include' }).then(parseResponse<SourceCredentials>),
    create: (input: SourceCreateInput): Promise<SourceResponse> => fetch(`${BASE_URL}/owner/sources`, { method: 'POST', credentials: 'include', headers: JSON_HEADERS, body: JSON.stringify(input) }).then(parseResponse<SourceResponse>),
    update: (id: string, input: SourceUpdateInput): Promise<SourceResponse> => fetch(`${BASE_URL}/owner/sources/${id}`, { method: 'PATCH', credentials: 'include', headers: JSON_HEADERS, body: JSON.stringify(input) }).then(parseResponse<SourceResponse>),
    remove: (id: string): Promise<void> => fetch(`${BASE_URL}/owner/sources/${id}`, { method: 'DELETE', credentials: 'include' }).then(parseResponse<void>),
    test: (id: string): Promise<ConnectTestResponse> => fetch(`${BASE_URL}/owner/sources/${id}/test`, { credentials: 'include' }).then(parseResponse<ConnectTestResponse>),
    import: (id: string): Promise<ImportRun> => fetch(`${BASE_URL}/owner/sources/${id}/import`, { method: 'POST', credentials: 'include' }).then(parseResponse<ImportRun>),
    uploadPlaylist: (id: string, file: File): Promise<SourceResponse> => fetch(`${BASE_URL}/owner/sources/${id}/playlist`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/octet-stream' }, body: file }).then(parseResponse<SourceResponse>),
  },
  imports: {
    list: (): Promise<ImportRunListResponse> => fetch(`${BASE_URL}/owner/imports`, { credentials: 'include' }).then(parseResponse<ImportRunListResponse>),
    detail: (id: string): Promise<ImportRun> => fetch(`${BASE_URL}/owner/imports/${id}`, { credentials: 'include' }).then(parseResponse<ImportRun>),
    cancel: (id: string): Promise<ImportRun> => fetch(`${BASE_URL}/owner/imports/${id}/cancel`, { method: 'POST', credentials: 'include' }).then(parseResponse<ImportRun>),
  },
};
