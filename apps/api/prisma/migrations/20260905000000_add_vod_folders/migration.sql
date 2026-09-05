-- Catalogue VOD administrable (console propriétaire) : dossiers en arbre,
-- règles automatiques sur le categoryTitle fournisseur, affectations manuelles
-- et sources YouTube rattachées. La chaîne Aforevo et le dossier « Nollywood »
-- cessent d'être codés en dur dans le front : ils naissent ici (seed idempotent).

ALTER TABLE "VodItem" ADD COLUMN "categoryKey" TEXT;

CREATE TABLE "VodFolder" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'BOTH',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isVisible" BOOLEAN NOT NULL DEFAULT true,
    "parentId" TEXT,

    CONSTRAINT "VodFolder_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "VodFolderRule" (
    "id" TEXT NOT NULL,
    "folderId" TEXT NOT NULL,
    "categoryKey" TEXT NOT NULL,
    "categoryTitle" TEXT NOT NULL,

    CONSTRAINT "VodFolderRule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "VodFolderItem" (
    "folderId" TEXT NOT NULL,
    "vodItemId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VodFolderItem_pkey" PRIMARY KEY ("folderId","vodItemId")
);

CREATE TABLE "VodYoutubeSource" (
    "id" TEXT NOT NULL,
    "folderId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "label" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VodYoutubeSource_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "VodFolder_slug_key" ON "VodFolder"("slug");
CREATE INDEX "VodFolder_parentId_isVisible_idx" ON "VodFolder"("parentId", "isVisible");
CREATE INDEX "VodFolder_kind_isVisible_idx" ON "VodFolder"("kind", "isVisible");
CREATE UNIQUE INDEX "VodFolderRule_folderId_categoryKey_key" ON "VodFolderRule"("folderId", "categoryKey");
CREATE INDEX "VodFolderRule_categoryKey_idx" ON "VodFolderRule"("categoryKey");
CREATE INDEX "VodFolderItem_vodItemId_idx" ON "VodFolderItem"("vodItemId");
CREATE UNIQUE INDEX "VodYoutubeSource_folderId_channelId_key" ON "VodYoutubeSource"("folderId", "channelId");
CREATE INDEX "VodYoutubeSource_channelId_isActive_idx" ON "VodYoutubeSource"("channelId", "isActive");
CREATE INDEX "VodItem_kind_categoryKey_isActive_idx" ON "VodItem"("kind", "categoryKey", "isActive");

ALTER TABLE "VodFolder" ADD CONSTRAINT "VodFolder_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "VodFolder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "VodFolderRule" ADD CONSTRAINT "VodFolderRule_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "VodFolder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VodFolderItem" ADD CONSTRAINT "VodFolderItem_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "VodFolder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VodFolderItem" ADD CONSTRAINT "VodFolderItem_vodItemId_fkey" FOREIGN KEY ("vodItemId") REFERENCES "VodItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VodYoutubeSource" ADD CONSTRAINT "VodYoutubeSource_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "VodFolder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill de la clé normalisée : mêmes transformations que la règle (PUT)
-- côté applicatif — trim + lowercase. Sans espace interne normalisé
-- volontairement : on colle au lower(trim(...)) SQL, source de vérité unique.
UPDATE "VodItem" SET "categoryKey" = lower(trim("categoryTitle")) WHERE "categoryTitle" IS NOT NULL;

-- Seed anti-régression : le rail Nollywood de l'app est resservi par la base
-- dès le déploiement. Ids littéraux fixes + ON CONFLICT DO NOTHING => la
-- migration est rejouable et n'écrase jamais une config owner existante.
INSERT INTO "VodFolder" ("id", "slug", "name", "kind", "sortOrder", "isVisible")
VALUES ('vodfolder_nollywood_seed', 'nollywood', 'Nollywood', 'MOVIE', 1, true)
ON CONFLICT DO NOTHING;
INSERT INTO "VodYoutubeSource" ("id", "folderId", "channelId", "label", "isActive", "sortOrder")
VALUES ('vodyt_aforevo_seed', 'vodfolder_nollywood_seed', 'UCyd79F-lNLCbGPQrf_L7KiA', 'Aforevo Galerie', true, 1)
ON CONFLICT DO NOTHING;
