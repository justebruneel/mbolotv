import { z } from 'zod';

export const userRoleSchema = z.enum(['USER', 'SUPPORT', 'ADMIN', 'OWNER']);
export type UserRole = z.infer<typeof userRoleSchema>;

export const sourceKindSchema = z.enum(['M3U', 'XTREAM', 'MAC_PORTAL']);
export type SourceKind = z.infer<typeof sourceKindSchema>;

export const sourceStatusSchema = z.enum(['PENDING', 'IMPORTING', 'READY', 'DEGRADED', 'FAILED', 'DISABLED']);
export type SourceStatus = z.infer<typeof sourceStatusSchema>;

export const importStateSchema = z.enum(['QUEUED', 'FETCHING', 'PARSING', 'NORMALIZING', 'COMPLETED', 'FAILED', 'CANCELED']);
export type ImportState = z.infer<typeof importStateSchema>;

// Périmètre d'un import de source : 'live' = chaînes uniquement, 'vod' =
// films/séries uniquement (sans toucher aux chaînes), 'all' = les deux,
// 'movies' = films seuls, 'series' = séries seules. Permet d'importer
// chaînes, films et séries de manière individuelle par source.
// Les lots d'ingestion VOD sont de 500 (progression persistée toutes les
// 500 entrées — une reprise ne rejoue jamais plus de 500 items).
export const importScopeSchema = z.enum(['live', 'vod', 'all', 'movies', 'series']);
export type ImportScope = z.infer<typeof importScopeSchema>;
export const sourceImportSchema = z.object({ scope: importScopeSchema.optional() });
export type SourceImportInput = z.infer<typeof sourceImportSchema>;

export const matchStateSchema = z.enum(['SCHEDULED', 'LIVE', 'FINISHED', 'POSTPONED']);
export type MatchState = z.infer<typeof matchStateSchema>;

export const sourceCreateSchema = z.object({ name: z.string().min(2).max(80), kind: sourceKindSchema, connection: z.record(z.string()), vodEnabled: z.boolean().optional(), scope: importScopeSchema.optional() });
export type SourceCreateInput = z.infer<typeof sourceCreateSchema>;
export type StreamAccess = { playbackUrl: string; expiresAt: string; selectedServer?: string };

export interface Category {
  id: string;
  slug: string;
  name: string;
  parentId?: string | null;
  isVisible?: boolean;
  channelCount?: number;
  sortOrder?: number;
  children?: Category[];
}
export const categorySchema: z.ZodType<Category> = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  parentId: z.string().nullable().optional(),
  isVisible: z.boolean().optional(),
  channelCount: z.number().optional(),
  sortOrder: z.number().optional(),
  children: z.array(z.lazy(() => categorySchema)).optional(),
});
export const nowPlayingSchema = z.object({ startsAt: z.string(), endsAt: z.string(), title: z.string(), imageUrl: z.string().nullable().optional(), type: z.enum(['movie','series','episode','sports','documentary','show','news','kids','other']).nullable().optional(), posterUrl: z.string().nullable().optional(), backdropUrl: z.string().nullable().optional() });
export type NowPlaying = z.infer<typeof nowPlayingSchema>;
export const channelSchema = z.object({ id: z.string(), name: z.string(), canonicalName: z.string(), country: z.string().nullable(), categoryId: z.string().nullable(), logoUrl: z.string().nullable(), healthStatus: z.enum(['OK', 'DOWN']).nullable().optional(), nowPlaying: nowPlayingSchema.nullable().optional() });
export type Channel = z.infer<typeof channelSchema>;
export const programmeSchema = z.object({
  id: z.string(),
  channelId: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  imageUrl: z.string().nullable().optional(),
  type: z.enum(['movie','series','episode','sports','documentary','show','news','kids','other']).nullable().optional(),
  seasonNumber: z.number().nullable().optional(),
  episodeNumber: z.number().nullable().optional(),
  posterUrl: z.string().nullable().optional(),
  backdropUrl: z.string().nullable().optional(),
  trailerUrl: z.string().nullable().optional(),
  genres: z.array(z.string()).nullable().optional(),
  year: z.number().nullable().optional(),
});
export type Programme = z.infer<typeof programmeSchema>;
export const matchChannelSchema = z.object({ id: z.string(), name: z.string(), logoUrl: z.string().nullable(), streamCount: z.number(), bestHealth: z.number().nullable() });
export type MatchChannel = z.infer<typeof matchChannelSchema>;
export const matchSchema = z.object({ id: z.string(), sport: z.string(), competition: z.string(), homeTeam: z.string(), awayTeam: z.string(), startsAt: z.string(), endsAt: z.string().nullable(), state: matchStateSchema, homeTeamLogo: z.string().nullable().optional(), awayTeamLogo: z.string().nullable().optional(), channels: z.array(matchChannelSchema).default([]) });
export type Match = z.infer<typeof matchSchema>;
export const matchPlaySchema = z.object({ channelId: z.string().optional() }).nullish().transform((value) => value ?? {});
export type MatchPlayInput = z.infer<typeof matchPlaySchema>;

export const channelQuerySchema = z.object({ category: z.string().optional(), country: z.string().optional(), q: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(100).optional(), offset: z.coerce.number().int().min(0).optional() });
export type ChannelQuery = z.infer<typeof channelQuerySchema>;
export const countryOptionSchema = z.object({ slug: z.string(), name: z.string(), count: z.number() });
export type CountryOption = z.infer<typeof countryOptionSchema>;
export const channelListResponseSchema = z.object({ items: z.array(channelSchema), total: z.number(), hasMore: z.boolean() });
export type ChannelListResponse = z.infer<typeof channelListResponseSchema>;
export const epgRangeQuerySchema = z.object({ from: z.string().datetime().optional(), to: z.string().datetime().optional(), category: z.string().optional() });
export type EpgRangeQuery = z.infer<typeof epgRangeQuerySchema>;
export const epgEntrySchema = z.object({ channel: channelSchema.omit({ nowPlaying: true }), programmes: z.array(programmeSchema) });
export type EpgEntry = z.infer<typeof epgEntrySchema>;
export const epgRangeResponseSchema = z.object({ items: z.array(epgEntrySchema), from: z.string(), to: z.string() });
export type EpgRangeResponse = z.infer<typeof epgRangeResponseSchema>;

export const programmeSearchItemSchema = z.object({ id: z.string(), channelId: z.string(), title: z.string(), description: z.string().nullable(), startsAt: z.string(), endsAt: z.string(), channel: z.object({ id: z.string(), name: z.string(), canonicalName: z.string(), country: z.string().nullable(), categoryId: z.string().nullable(), logoUrl: z.string().nullable() }) });
export type ProgrammeSearchItem = z.infer<typeof programmeSearchItemSchema>;
export const programmeSearchQuerySchema = z.object({ q: z.string().min(1).max(80), category: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(30) });
export type ProgrammeSearchQuery = z.infer<typeof programmeSearchQuerySchema>;
export const programmeSearchResponseSchema = z.object({ items: z.array(programmeSearchItemSchema), total: z.number() });
export type ProgrammeSearchResponse = z.infer<typeof programmeSearchResponseSchema>;

export const matchQuerySchema = z.object({ state: matchStateSchema.optional(), sport: z.string().optional(), from: z.string().datetime().optional(), to: z.string().datetime().optional() });
export type MatchQuery = z.infer<typeof matchQuerySchema>;
export const matchListResponseSchema = z.object({ items: z.array(matchSchema), total: z.number() });
export type MatchListResponse = z.infer<typeof matchListResponseSchema>;
export const playResponseSchema = z.object({ url: z.string().url(), expiresAt: z.string(), qualityCap: z.number().int().optional() });
export type PlayResponse = z.infer<typeof playResponseSchema>;
// ---- VOD (films & séries) ----
export const vodKindSchema = z.enum(['MOVIE', 'SERIES']);
export type VodKind = z.infer<typeof vodKindSchema>;
export const vodItemSchema = z.object({ id: z.string(), kind: vodKindSchema, title: z.string(), posterUrl: z.string().nullable(), rating: z.number().nullable(), category: z.string().nullable(), addedAt: z.string().nullable() });
export type VodItem = z.infer<typeof vodItemSchema>;
export const vodListResponseSchema = z.object({ items: z.array(vodItemSchema), total: z.number(), hasMore: z.boolean() });
export type VodListResponse = z.infer<typeof vodListResponseSchema>;
export const vodCategorySchema = z.object({ name: z.string(), count: z.number() });
export type VodCategory = z.infer<typeof vodCategorySchema>;
export const vodEpisodeSchema = z.object({ id: z.string(), num: z.number(), title: z.string().nullable(), containerExt: z.string().optional() });
export type VodEpisode = z.infer<typeof vodEpisodeSchema>;
export const vodSeasonSchema = z.object({ number: z.number(), episodes: z.array(vodEpisodeSchema) });
export type VodSeason = z.infer<typeof vodSeasonSchema>;
export const vodSeasonsResponseSchema = z.object({ seasons: z.array(vodSeasonSchema) });
export type VodSeasonsResponse = z.infer<typeof vodSeasonsResponseSchema>;
// ---- YouTube (onglet Nollywood : parcourir + lire via embed) ----
export const youtubeVideoSchema = z.object({ id: z.string(), title: z.string(), description: z.string().nullable(), posterUrl: z.string().nullable(), publishedAt: z.string().nullable(), duration: z.number().nullable() });
export type YoutubeVideo = z.infer<typeof youtubeVideoSchema>;
export const youtubeListResponseSchema = z.object({ items: z.array(youtubeVideoSchema), nextPageToken: z.string().nullable() });
export type YoutubeListResponse = z.infer<typeof youtubeListResponseSchema>;

export const ownerLoginSchema = z.object({ email: z.string().email(), password: z.string().min(1).max(200) });
export type OwnerLoginInput = z.infer<typeof ownerLoginSchema>;
export const ownerMeSchema = z.object({ id: z.string(), email: z.string(), role: z.string() });
export type OwnerMe = z.infer<typeof ownerMeSchema>;
export const ownerProfileSchema = z.object({ id: z.string(), email: z.string(), role: z.string(), whatsappContact: z.string().nullable() });
export type OwnerProfile = z.infer<typeof ownerProfileSchema>;
export const ownerProfileUpdateSchema = z.object({ whatsappContact: z.string().max(120).nullable().optional() }).refine((value) => Object.keys(value).length > 0, 'Aucune modification');
export type OwnerProfileUpdateInput = z.infer<typeof ownerProfileUpdateSchema>;
export const ownerSessionSchema = z.object({ id: z.string(), userAgent: z.string().nullable(), ipHash: z.string().nullable(), createdAt: z.string(), expiresAt: z.string(), current: z.boolean() });
export type OwnerSession = z.infer<typeof ownerSessionSchema>;

export const sourceResponseSchema = z.object({ id: z.string(), name: z.string(), kind: sourceKindSchema, status: sourceStatusSchema, priority: z.number(), vodEnabled: z.boolean().optional(), lastSyncedAt: z.string().nullable(), createdAt: z.string() });
export type SourceResponse = z.infer<typeof sourceResponseSchema>;
export const sourceDetailSchema = sourceResponseSchema.extend({ connectionMasked: z.record(z.string()), variantsCount: z.number() });
export type SourceDetail = z.infer<typeof sourceDetailSchema>;
export const sourceCredentialsSchema = z.object({ connection: z.record(z.string()) });
export type SourceCredentials = z.infer<typeof sourceCredentialsSchema>;
export const sourceUpdateSchema = z.object({ name: z.string().min(2).max(80).optional(), priority: z.number().int().min(1).max(1000).optional(), status: z.enum(['READY', 'DEGRADED', 'FAILED', 'DISABLED']).optional(), vodEnabled: z.boolean().optional(), scope: importScopeSchema.optional() });
export type SourceUpdateInput = z.infer<typeof sourceUpdateSchema>;
export const connectTestResponseSchema = z.object({ ok: z.boolean(), latencyMs: z.number().nullable(), error: z.string().nullable() });
export type ConnectTestResponse = z.infer<typeof connectTestResponseSchema>;
export const importRunSchema = z.object({ id: z.string(), sourceId: z.string(), sourceName: z.string(), state: importStateSchema, scope: importScopeSchema, metrics: z.record(z.number()).nullable(), errorCode: z.string().nullable(), errorMessage: z.string().nullable(), startedAt: z.string(), completedAt: z.string().nullable() });
export type ImportRun = z.infer<typeof importRunSchema>;
export const importRunListResponseSchema = z.object({ items: z.array(importRunSchema), total: z.number() });
export type ImportRunListResponse = z.infer<typeof importRunListResponseSchema>;
export const auditEntrySchema = z.object({ id: z.string(), action: z.string(), entity: z.string(), entityId: z.string().nullable(), actorId: z.string().nullable(), metadata: z.record(z.unknown()).nullable(), createdAt: z.string() });
export type AuditEntry = z.infer<typeof auditEntrySchema>;
export const alertSchema = z.object({ severity: z.enum(['warning', 'critical']), message: z.string() });
export type Alert = z.infer<typeof alertSchema>;
export const overviewSchema = z.object({ sourcesByStatus: z.record(z.number()), channelCount: z.number(), variantCount: z.number(), activeImports: z.number(), liveMatches: z.number(), alerts: z.array(alertSchema), recentAudit: z.array(auditEntrySchema) });
export type Overview = z.infer<typeof overviewSchema>;

export const activityHeartbeatSchema = z.object({ channelId: z.string().optional() });
export type ActivityHeartbeatInput = z.infer<typeof activityHeartbeatSchema>;
export const activeCountsResponseSchema = z.object({ global: z.number() });
export type ActiveCountsResponse = z.infer<typeof activeCountsResponseSchema>;
export const channelViewersResponseSchema = z.object({ count: z.number() });
export type ChannelViewersResponse = z.infer<typeof channelViewersResponseSchema>;

export const ownerCategoryUpdateSchema = z.object({ name: z.string().min(1).max(120).optional(), isVisible: z.boolean().optional(), parentId: z.string().nullable().optional(), sortOrder: z.number().int().min(0).optional() }).refine((value) => Object.keys(value).length > 0, 'Aucune modification');
export type OwnerCategoryUpdateInput = z.infer<typeof ownerCategoryUpdateSchema>;
export const ownerCategoryCreateSchema = z.object({ name: z.string().min(1).max(120), parentId: z.string().nullable().optional() });
export type OwnerCategoryCreateInput = z.infer<typeof ownerCategoryCreateSchema>;
export const ownerChannelUpdateSchema = z.object({ name: z.string().min(1).max(160).optional(), isVisible: z.boolean().optional() }).refine((value) => Object.keys(value).length > 0, 'Aucune modification');
export type OwnerChannelUpdateInput = z.infer<typeof ownerChannelUpdateSchema>;
export const ownerChannelSchema = z.object({ id: z.string(), name: z.string(), canonicalName: z.string(), categoryId: z.string().nullable(), isVisible: z.boolean(), healthStatus: z.enum(['OK', 'DOWN']).nullable(), variantsCount: z.number() });
export type OwnerChannel = z.infer<typeof ownerChannelSchema>;
export interface OwnerCategory {
  id: string;
  slug: string;
  name: string;
  parentId: string | null;
  isVisible: boolean;
  effectiveVisible: boolean;
  channelCount: number;
  sortOrder: number;
  channels: OwnerChannel[];
  children: OwnerCategory[];
}
export const ownerCategorySchema: z.ZodType<OwnerCategory> = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  parentId: z.string().nullable(),
  isVisible: z.boolean(),
  effectiveVisible: z.boolean(),
  channelCount: z.number(),
  sortOrder: z.number(),
  channels: z.array(ownerChannelSchema),
  children: z.array(z.lazy(() => ownerCategorySchema)),
});
export const ownerCatalogSchema = z.object({ categories: z.array(ownerCategorySchema), uncategorized: z.array(ownerChannelSchema), uncategorizedCount: z.number() });
export type OwnerCatalog = z.infer<typeof ownerCatalogSchema>;
export const channelTestResponseSchema = z.object({ ok: z.boolean(), status: z.enum(['OK', 'DOWN']), checked: z.number() });
export type ChannelTestResponse = z.infer<typeof channelTestResponseSchema>;

export const accessCodeCreateSchema = z.object({ kind: z.enum(['STANDARD', 'PROMO']).default('STANDARD'), durationDays: z.union([z.literal(7), z.literal(14), z.literal(30)]).optional() });
export type AccessCodeCreateInput = z.infer<typeof accessCodeCreateSchema>;
export const accessCodeSchema = z.object({ id: z.string(), code: z.string().nullable(), codeLast4: z.string(), kind: z.enum(['STANDARD', 'PROMO']), durationHours: z.number(), active: z.boolean(), createdAt: z.string(), expiresAt: z.string().nullable(), deviceBound: z.boolean() });
export type AccessCode = z.infer<typeof accessCodeSchema>;
export const accessStatusSchema = z.object({ active: z.boolean(), expiresAt: z.string().nullable(), kind: z.enum(['STANDARD', 'PROMO']).nullable(), whatsappUrl: z.string() });
export type AccessStatus = z.infer<typeof accessStatusSchema>;
export const accessRedeemSchema = z.object({ code: z.string().min(4).max(64) });
export type AccessRedeemInput = z.infer<typeof accessRedeemSchema>;

/* ---------- Notifications (push, rappels, annonces) ---------- */
export const pushSubscriptionSchema = z.object({
  endpoint: z.string().min(1),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
});
export type PushSubscriptionInput = z.infer<typeof pushSubscriptionSchema>;

export const reminderCreateSchema = z.object({
  programmeId: z.string().min(1),
  channelId: z.string().min(1),
  channelName: z.string().min(1),
  title: z.string().min(1).max(200),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
});
export type ReminderCreateInput = z.infer<typeof reminderCreateSchema>;
export const reminderSchema = reminderCreateSchema.extend({ fired: z.boolean() });
export type Reminder = z.infer<typeof reminderSchema>;
export const reminderListSchema = z.object({ items: z.array(reminderSchema) });
export type ReminderList = z.infer<typeof reminderListSchema>;

export const announcementKindSchema = z.enum(['INFO', 'VERSION', 'PROMO']);
export type AnnouncementKind = z.infer<typeof announcementKindSchema>;
export const announcementSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  kind: announcementKindSchema,
  status: z.enum(['DRAFT', 'SENT']),
  createdAt: z.string(),
  sentAt: z.string().nullable(),
});
export type Announcement = z.infer<typeof announcementSchema>;
export const announcementCreateSchema = z.object({
  title: z.string().min(3).max(80),
  body: z.string().min(3).max(500),
  kind: announcementKindSchema.default('INFO'),
});
export type AnnouncementCreateInput = z.infer<typeof announcementCreateSchema>;
export const announcementListSchema = z.object({ items: z.array(announcementSchema) });
export type AnnouncementList = z.infer<typeof announcementListSchema>;
