-- Titres externes (lecteurs tiers Mixdrop/Dood/Voe/Uqload) : métas importées
-- depuis une fiche (French Stream, …) + N lecteurs par titre. Catalogue
-- global comme VodFolder (pas d'ownerId). La lecture passe par /api/x/play
-- (résolution au clic) : aucun lien direct éphémère n'est stocké, seuls les
-- embeds d'origine (+ finale après wrapper) et le statut de santé le sont.

CREATE TABLE "ExternalTitle" (
    "id" TEXT NOT NULL,
    "site" TEXT NOT NULL,
    "siteRef" TEXT,
    "title" TEXT NOT NULL,
    "year" INTEGER,
    "posterUrl" TEXT,
    "backdropUrl" TEXT,
    "trailerYoutubeId" TEXT,
    "isVisible" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExternalTitle_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ExternalSource" (
    "id" TEXT NOT NULL,
    "titleId" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "embedUrl" TEXT NOT NULL,
    "finalUrl" TEXT,
    "versions" TEXT[] NOT NULL DEFAULT '{}',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastStatus" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "lastError" TEXT,
    "lastCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExternalSource_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ExternalSource" ADD CONSTRAINT "ExternalSource_titleId_fkey"
    FOREIGN KEY ("titleId") REFERENCES "ExternalTitle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "ExternalTitle_site_siteRef_key" ON "ExternalTitle"("site", "siteRef");
CREATE INDEX "ExternalTitle_isVisible_sortOrder_idx" ON "ExternalTitle"("isVisible", "sortOrder");
CREATE UNIQUE INDEX "ExternalSource_titleId_host_embedUrl_key" ON "ExternalSource"("titleId", "host", "embedUrl");
CREATE INDEX "ExternalSource_isActive_lastCheckedAt_idx" ON "ExternalSource"("isActive", "lastCheckedAt");
