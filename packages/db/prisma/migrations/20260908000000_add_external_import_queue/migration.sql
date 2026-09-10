-- Bot d'import automatique des fiches French Stream : file d'attente
-- persistante. Chaque ligne = une fiche découverte dans un listing
-- (newsid unique par site), à traiter par petits lots à chaque tick du cron.
-- kind est posé à la découverte (films→MOVIE, s-tv→SERIES) : le bot sait
-- quel scraper appeler sans re-scanner la fiche.
CREATE TABLE "ExternalImportQueue" (
    "id" TEXT NOT NULL,
    "site" TEXT NOT NULL DEFAULT 'frenchstream',
    "category" TEXT NOT NULL,
    "newsid" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'MOVIE',
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "ExternalImportQueue_pkey" PRIMARY KEY ("id")
);

-- Dédup : une fiche ne peut être dans la file qu'une fois par site.
CREATE UNIQUE INDEX "ExternalImportQueue_site_newsid_key" ON "ExternalImportQueue"("site", "newsid");
-- File de travail : priorités d'abord (nouveautés page 1), puis moins
-- tentés, puis plus anciens.
CREATE INDEX "ExternalImportQueue_state_priority_idx" ON "ExternalImportQueue"("state", "priority" DESC, "attempts" ASC, "discoveredAt" ASC);

-- Classification film/série des titres externes : posée à l'import (bot :
-- via le listing films/s-tv ; console : via le scraper).
ALTER TABLE "ExternalTitle" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'MOVIE';
