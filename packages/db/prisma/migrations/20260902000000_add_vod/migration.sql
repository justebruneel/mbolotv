-- VOD (films/séries) : import depuis les sources Xtream (vodEnabled) et
-- favoris dédiés. Les épisodes ne sont PAS stockés : résolus à la lecture
-- (get_series_info) depuis le locator chiffré de la série.
ALTER TABLE "Source" ADD COLUMN "vodEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "VodItem" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "normalizedKey" TEXT NOT NULL,
    "posterUrl" TEXT,
    "rating" DOUBLE PRECISION,
    "categoryTitle" TEXT,
    "containerExt" TEXT,
    "addedAt" TIMESTAMP(3),
    "sourceId" TEXT NOT NULL,
    "encryptedLocator" BYTEA NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isVisible" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VodItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "VodFavorite" (
    "deviceId" TEXT NOT NULL,
    "vodItemId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VodFavorite_pkey" PRIMARY KEY ("deviceId","vodItemId")
);

CREATE UNIQUE INDEX "VodItem_normalizedKey_key" ON "VodItem"("normalizedKey");
CREATE INDEX "VodItem_kind_categoryTitle_isActive_idx" ON "VodItem"("kind", "categoryTitle", "isActive");
CREATE INDEX "VodItem_sourceId_isActive_idx" ON "VodItem"("sourceId", "isActive");
CREATE INDEX "VodFavorite_deviceId_createdAt_idx" ON "VodFavorite"("deviceId", "createdAt");

ALTER TABLE "VodItem" ADD CONSTRAINT "VodItem_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VodFavorite" ADD CONSTRAINT "VodFavorite_vodItemId_fkey" FOREIGN KEY ("vodItemId") REFERENCES "VodItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
