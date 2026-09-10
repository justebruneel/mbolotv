-- Détails « façon Netflix » des titres externes : synopsis, genres, durée,
-- réalisateur, acteurs, titre original — extraits par le scraper (parseurs
-- défensifs, tout est null-able) et affichés sur la fiche /vod/x. Colonne
-- "ficheUrl" ajoutée : mémorise l'URL d'origine pour le re-scrapping des
-- titres déjà publiés (backfill, POST /api/owner/vod/external/resync).
ALTER TABLE "ExternalTitle" ADD COLUMN "synopsis" TEXT,
ADD COLUMN "originalTitle" TEXT,
ADD COLUMN "duration" TEXT,
ADD COLUMN "director" TEXT,
ADD COLUMN "cast" TEXT,
ADD COLUMN "genres" TEXT[] NOT NULL DEFAULT '{}',
ADD COLUMN "ficheUrl" TEXT;
