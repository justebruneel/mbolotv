import type {
  AccessCode,
  AccessCodeCreateInput,
  Announcement,
  AnnouncementCreateInput,
  AnnouncementList,
  AuditEntry,
  ChannelTestResponse,
  ConnectTestResponse,
  ImportRun,
  ImportRunListResponse,
  ImportScope,
  Overview,
  OwnerCatalog,
  OwnerChannel,
  OwnerCategoryCreateInput,
  OwnerCategoryUpdateInput,
  OwnerChannelUpdateInput,
  OwnerLoginInput,
  OwnerMe,
  OwnerProfile,
  OwnerProfileUpdateInput,
  OwnerVodAvailableCategory,
  OwnerVodCatalog,
  OwnerVodFolderCreateInput,
  OwnerVodFolderUpdateInput,
  OwnerVodItemAssignInput,
  OwnerVodItemSummary,
  OwnerVodYoutubeCreateInput,
  OwnerVodYoutubeSource,
  OwnerVodYoutubeUpdateInput,
  SourceCreateInput,
  SourceCredentials,
  SourceDetail,
  SourceResponse,
  SourceUpdateInput,
} from '@mbolo/contracts';

export interface FeaturedChannelEntry { id: string; name: string; logoUrl: string | null; }
export interface FeaturedCountryGroup { country: string; channels: FeaturedChannelEntry[]; }
export type FeaturedListResponse = { items: FeaturedCountryGroup[] };

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
  // Canaux paginés par dossier (l'arbre du catalogue ne les embarque plus).
  // categoryId 'none' = sans dossier ; absent = recherche dans tout le catalogue.
  catalogChannels: (params: { categoryId?: string | null; q?: string; limit?: number; offset?: number } = {}): Promise<{ items: OwnerChannel[]; total: number }> => {
    const search = new URLSearchParams();
    if (params.categoryId != null) search.set('categoryId', params.categoryId);
    if (params.q) search.set('q', params.q);
    if (params.limit != null) search.set('limit', String(params.limit));
    if (params.offset != null) search.set('offset', String(params.offset));
    const qs = search.toString();
    return fetch(`${BASE_URL}/owner/catalog/channels${qs ? `?${qs}` : ''}`, { credentials: 'include' }).then(parseResponse<{ items: OwnerChannel[]; total: number }>);
  },
  categories: {
    create: (input: OwnerCategoryCreateInput): Promise<OwnerCatalog> => fetch(`${BASE_URL}/owner/categories`, { method: 'POST', credentials: 'include', headers: JSON_HEADERS, body: JSON.stringify(input) }).then(parseResponse<OwnerCatalog>),
    update: (id: string, input: OwnerCategoryUpdateInput): Promise<OwnerCatalog> => fetch(`${BASE_URL}/owner/categories/${id}`, { method: 'PATCH', credentials: 'include', headers: JSON_HEADERS, body: JSON.stringify(input) }).then(parseResponse<OwnerCatalog>),
    remove: (id: string): Promise<OwnerCatalog> => fetch(`${BASE_URL}/owner/categories/${id}`, { method: 'DELETE', credentials: 'include' }).then(parseResponse<OwnerCatalog>),
    removeBatch: (ids: string[]): Promise<OwnerCatalog> => fetch(`${BASE_URL}/owner/categories/delete-batch`, { method: 'POST', credentials: 'include', headers: JSON_HEADERS, body: JSON.stringify({ ids }) }).then(parseResponse<OwnerCatalog>),
  },
  // ---- Catalogue VOD : dossiers, règles, affectations, sources YouTube ----
  vod: {
    catalog: (): Promise<OwnerVodCatalog> => fetch(`${BASE_URL}/owner/vod/catalog`, { credentials: 'include' }).then(parseResponse<OwnerVodCatalog>),
    items: (params: { folderId?: string | null; q?: string; kind?: 'MOVIE' | 'SERIES'; limit?: number; offset?: number } = {}): Promise<{ items: OwnerVodItemSummary[]; total: number }> => {
      const search = new URLSearchParams();
      if (params.folderId != null) search.set('folderId', params.folderId);
      if (params.q) search.set('q', params.q);
      if (params.kind) search.set('kind', params.kind);
      if (params.limit != null) search.set('limit', String(params.limit));
      if (params.offset != null) search.set('offset', String(params.offset));
      const qs = search.toString();
      return fetch(`${BASE_URL}/owner/vod/catalog/items${qs ? `?${qs}` : ''}`, { credentials: 'include' }).then(parseResponse<{ items: OwnerVodItemSummary[]; total: number }>);
    },
    availableCategories: (kind?: 'MOVIE' | 'SERIES'): Promise<OwnerVodAvailableCategory[]> => fetch(`${BASE_URL}/owner/vod/categories/available${kind ? `?kind=${kind}` : ''}`, { credentials: 'include' }).then(parseResponse<OwnerVodAvailableCategory[]>),
    folders: {
      create: (input: OwnerVodFolderCreateInput): Promise<OwnerVodCatalog> => fetch(`${BASE_URL}/owner/vod/folders`, { method: 'POST', credentials: 'include', headers: JSON_HEADERS, body: JSON.stringify(input) }).then(parseResponse<OwnerVodCatalog>),
      update: (id: string, input: OwnerVodFolderUpdateInput): Promise<OwnerVodCatalog> => fetch(`${BASE_URL}/owner/vod/folders/${id}`, { method: 'PATCH', credentials: 'include', headers: JSON_HEADERS, body: JSON.stringify(input) }).then(parseResponse<OwnerVodCatalog>),
      remove: (id: string): Promise<OwnerVodCatalog> => fetch(`${BASE_URL}/owner/vod/folders/${id}`, { method: 'DELETE', credentials: 'include' }).then(parseResponse<OwnerVodCatalog>),
    },
    rules: {
      set: (folderId: string, categoryTitles: string[]): Promise<OwnerVodCatalog> => fetch(`${BASE_URL}/owner/vod/folders/${folderId}/rules`, { method: 'PUT', credentials: 'include', headers: JSON_HEADERS, body: JSON.stringify({ categoryTitles }) }).then(parseResponse<OwnerVodCatalog>),
    },
    assign: {
      addToFolder: (folderId: string, itemIds: string[]): Promise<{ added: number }> => fetch(`${BASE_URL}/owner/vod/folders/${folderId}/items`, { method: 'POST', credentials: 'include', headers: JSON_HEADERS, body: JSON.stringify({ itemIds }) }).then(parseResponse<{ added: number }>),
      removeFromFolder: (folderId: string, itemId: string): Promise<void> => fetch(`${BASE_URL}/owner/vod/folders/${folderId}/items/${itemId}`, { method: 'DELETE', credentials: 'include' }).then(parseResponse<void>),
      setItemFolders: (itemId: string, input: OwnerVodItemAssignInput): Promise<OwnerVodItemSummary> => fetch(`${BASE_URL}/owner/vod/items/${itemId}`, { method: 'PATCH', credentials: 'include', headers: JSON_HEADERS, body: JSON.stringify(input) }).then(parseResponse<OwnerVodItemSummary>),
    },
    youtube: {
      list: (folderId: string): Promise<{ items: OwnerVodYoutubeSource[] }> => fetch(`${BASE_URL}/owner/vod/folders/${folderId}/youtube`, { credentials: 'include' }).then(parseResponse<{ items: OwnerVodYoutubeSource[] }>),
      create: (folderId: string, input: OwnerVodYoutubeCreateInput): Promise<OwnerVodCatalog> => fetch(`${BASE_URL}/owner/vod/folders/${folderId}/youtube`, { method: 'POST', credentials: 'include', headers: JSON_HEADERS, body: JSON.stringify(input) }).then(parseResponse<OwnerVodCatalog>),
      update: (id: string, input: OwnerVodYoutubeUpdateInput): Promise<OwnerVodCatalog> => fetch(`${BASE_URL}/owner/vod/youtube/${id}`, { method: 'PATCH', credentials: 'include', headers: JSON_HEADERS, body: JSON.stringify(input) }).then(parseResponse<OwnerVodCatalog>),
      remove: (id: string): Promise<OwnerVodCatalog> => fetch(`${BASE_URL}/owner/vod/youtube/${id}`, { method: 'DELETE', credentials: 'include' }).then(parseResponse<OwnerVodCatalog>),
    },
  },
  profile: (): Promise<OwnerProfile> => fetch(`${BASE_URL}/owner/profile`, { credentials: 'include' }).then(parseResponse<OwnerProfile>),
  profileUpdate: (input: OwnerProfileUpdateInput): Promise<OwnerProfile> => fetch(`${BASE_URL}/owner/profile`, { method: 'PATCH', credentials: 'include', headers: JSON_HEADERS, body: JSON.stringify(input) }).then(parseResponse<OwnerProfile>),
  channels: {
    update: (id: string, input: OwnerChannelUpdateInput): Promise<OwnerCatalog> => fetch(`${BASE_URL}/owner/channels/${id}`, { method: 'PATCH', credentials: 'include', headers: JSON_HEADERS, body: JSON.stringify(input) }).then(parseResponse<OwnerCatalog>),
    test: (id: string): Promise<ChannelTestResponse> => fetch(`${BASE_URL}/owner/channels/${id}/test`, { method: 'POST', credentials: 'include' }).then(parseResponse<ChannelTestResponse>),
    removeBatch: (ids: string[]): Promise<{ deleted: number }> => fetch(`${BASE_URL}/owner/channels/delete-batch`, { method: 'POST', credentials: 'include', headers: JSON_HEADERS, body: JSON.stringify({ ids }) }).then(parseResponse<{ deleted: number }>),
    ids: (scope: 'uncategorized'): Promise<{ ids: string[]; total: number }> => fetch(`${BASE_URL}/owner/channels/ids?scope=${scope}`, { credentials: 'include' }).then(parseResponse<{ ids: string[]; total: number }>),
  },
  featured: {
    list: (): Promise<FeaturedListResponse> => fetch(`${BASE_URL}/owner/featured`, { credentials: 'include' }).then(parseResponse<FeaturedListResponse>),
    set: (country: string, channelIds: string[]): Promise<FeaturedListResponse> => fetch(`${BASE_URL}/owner/featured/${encodeURIComponent(country)}`, { method: 'PUT', credentials: 'include', headers: JSON_HEADERS, body: JSON.stringify({ channelIds }) }).then(parseResponse<FeaturedListResponse>),
    remove: (country: string, channelId: string): Promise<FeaturedListResponse> => fetch(`${BASE_URL}/owner/featured/${encodeURIComponent(country)}/${encodeURIComponent(channelId)}`, { method: 'DELETE', credentials: 'include' }).then(parseResponse<FeaturedListResponse>),
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
    import: (id: string, scope?: ImportScope): Promise<ImportRun> => fetch(`${BASE_URL}/owner/sources/${id}/import`, { method: 'POST', credentials: 'include', ...(scope ? { headers: JSON_HEADERS, body: JSON.stringify({ scope }) } : {}) }).then(parseResponse<ImportRun>),
    uploadPlaylist: (id: string, file: File, scope?: ImportScope): Promise<SourceResponse> => fetch(`${BASE_URL}/owner/sources/${id}/playlist${scope && scope !== 'all' ? `?scope=${scope}` : ''}`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/octet-stream' }, body: file }).then(parseResponse<SourceResponse>),
  },
  imports: {
    list: (): Promise<ImportRunListResponse> => fetch(`${BASE_URL}/owner/imports`, { credentials: 'include' }).then(parseResponse<ImportRunListResponse>),
    detail: (id: string): Promise<ImportRun> => fetch(`${BASE_URL}/owner/imports/${id}`, { credentials: 'include' }).then(parseResponse<ImportRun>),
    cancel: (id: string): Promise<ImportRun> => fetch(`${BASE_URL}/owner/imports/${id}/cancel`, { method: 'POST', credentials: 'include' }).then(parseResponse<ImportRun>),
  },
  notifications: {
    list: (): Promise<AnnouncementList> => fetch(`${BASE_URL}/owner/notifications`, { credentials: 'include' }).then(parseResponse<AnnouncementList>),
    create: (input: AnnouncementCreateInput): Promise<Announcement> => fetch(`${BASE_URL}/owner/notifications`, { method: 'POST', credentials: 'include', headers: JSON_HEADERS, body: JSON.stringify(input) }).then(parseResponse<Announcement>),
    publish: (id: string): Promise<Announcement> => fetch(`${BASE_URL}/owner/notifications/${id}/publish`, { method: 'POST', credentials: 'include' }).then(parseResponse<Announcement>),
    remove: (id: string): Promise<void> => fetch(`${BASE_URL}/owner/notifications/${id}`, { method: 'DELETE', credentials: 'include' }).then(parseResponse<void>),
  },
};
