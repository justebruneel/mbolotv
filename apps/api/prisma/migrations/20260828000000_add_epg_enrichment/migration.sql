-- Add TMDB cache and EPG mapping for professional EPG system
CREATE TABLE "TmdbCache" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cacheKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "year" INTEGER,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TmdbCache_cacheKey_key" UNIQUE ("cacheKey")
);
CREATE INDEX "TmdbCache_expiresAt_idx" ON "TmdbCache"("expiresAt");
CREATE INDEX "TmdbCache_title_idx" ON "TmdbCache"("title");

CREATE TABLE "ChannelEpgMapping" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "channelId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ChannelEpgMapping_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ChannelEpgMapping_channelId_provider_key" UNIQUE ("channelId", "provider")
);
CREATE INDEX "ChannelEpgMapping_provider_externalId_idx" ON "ChannelEpgMapping"("provider", "externalId");
