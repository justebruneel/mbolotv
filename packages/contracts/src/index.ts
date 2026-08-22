import { z } from 'zod';

export const userRoleSchema = z.enum(['USER', 'SUPPORT', 'ADMIN', 'OWNER']);
export type UserRole = z.infer<typeof userRoleSchema>;

export const sourceKindSchema = z.enum(['M3U', 'XTREAM', 'MAC_PORTAL']);
export type SourceKind = z.infer<typeof sourceKindSchema>;

export const sourceStatusSchema = z.enum(['PENDING', 'IMPORTING', 'READY', 'DEGRADED', 'FAILED', 'DISABLED']);
export type SourceStatus = z.infer<typeof sourceStatusSchema>;

export const importStateSchema = z.enum(['QUEUED', 'FETCHING', 'PARSING', 'NORMALIZING', 'COMPLETED', 'FAILED', 'CANCELED']);
export type ImportState = z.infer<typeof importStateSchema>;

export const matchStateSchema = z.enum(['SCHEDULED', 'LIVE', 'FINISHED', 'POSTPONED']);
export type MatchState = z.infer<typeof matchStateSchema>;

export const sourceCreateSchema = z.object({ name: z.string().min(2).max(80), kind: sourceKindSchema, connection: z.record(z.string()) });
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
export const nowPlayingSchema = z.object({ startsAt: z.string(), endsAt: z.string(), title: z.string(), imageUrl: z.string().nullable().optional() });
export type NowPlaying = z.infer<typeof nowPlayingSchema>;
export const channelSchema = z.object({ id: z.string(), name: z.string(), canonicalName: z.string(), country: z.string().nullable(), categoryId: z.string().nullable(), logoUrl: z.string().nullable(), healthStatus: z.enum(['OK', 'DOWN']).nullable().optional(), nowPlaying: nowPlayingSchema.nullable().optional() });
export type Channel = z.infer<typeof channelSchema>;
export const programmeSchema = z.object({ id: z.string(), channelId: z.string(), startsAt: z.string(), endsAt: z.string(), title: z.string(), description: z.string().nullable(), imageUrl: z.string().nullable().optional() });
export type Programme = z.infer<typeof programmeSchema>;
export const matchChannelSchema = z.object({ id: z.string(), name: z.string(), logoUrl: z.string().nullable(), streamCount: z.number(), bestHealth: z.number().nullable() });
export type MatchChannel = z.infer<typeof matchChannelSchema>;
export const matchSchema = z.object({ id: z.string(), sport: z.string(), competition: z.string(), homeTeam: z.string(), awayTeam: z.string(), startsAt: z.string(), endsAt: z.string().nullable(), state: matchStateSchema, channels: z.array(matchChannelSchema).default([]) });
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
export const playResponseSchema = z.object({ url: z.string().url(), expiresAt: z.string() });
export type PlayResponse = z.infer<typeof playResponseSchema>;

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

export const sourceResponseSchema = z.object({ id: z.string(), name: z.string(), kind: sourceKindSchema, status: sourceStatusSchema, priority: z.number(), lastSyncedAt: z.string().nullable(), createdAt: z.string() });
export type SourceResponse = z.infer<typeof sourceResponseSchema>;
export const sourceDetailSchema = sourceResponseSchema.extend({ connectionMasked: z.record(z.string()), variantsCount: z.number() });
export type SourceDetail = z.infer<typeof sourceDetailSchema>;
export const sourceCredentialsSchema = z.object({ connection: z.record(z.string()) });
export type SourceCredentials = z.infer<typeof sourceCredentialsSchema>;
export const sourceUpdateSchema = z.object({ name: z.string().min(2).max(80).optional(), priority: z.number().int().min(1).max(1000).optional(), status: z.enum(['READY', 'DEGRADED', 'FAILED', 'DISABLED']).optional() });
export type SourceUpdateInput = z.infer<typeof sourceUpdateSchema>;
export const connectTestResponseSchema = z.object({ ok: z.boolean(), latencyMs: z.number().nullable(), error: z.string().nullable() });
export type ConnectTestResponse = z.infer<typeof connectTestResponseSchema>;
export const importRunSchema = z.object({ id: z.string(), sourceId: z.string(), sourceName: z.string(), state: importStateSchema, metrics: z.record(z.number()).nullable(), errorCode: z.string().nullable(), errorMessage: z.string().nullable(), startedAt: z.string(), completedAt: z.string().nullable() });
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

export const ownerCategoryUpdateSchema = z.object({ name: z.string().min(1).max(120).optional(), isVisible: z.boolean().optional(), parentId: z.string().nullable().optional() }).refine((value) => Object.keys(value).length > 0, 'Aucune modification');
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
  channels: z.array(ownerChannelSchema),
  children: z.array(z.lazy(() => ownerCategorySchema)),
});
export const ownerCatalogSchema = z.object({ categories: z.array(ownerCategorySchema), uncategorized: z.array(ownerChannelSchema) });
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
