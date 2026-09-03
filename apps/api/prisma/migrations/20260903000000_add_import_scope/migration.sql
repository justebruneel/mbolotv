-- Périmètre d'import par run : "live" (chaînes uniquement), "vod"
-- (films/séries uniquement, sans toucher aux chaînes), "all" (les deux).
-- Les chaînes gardent leur import individuel, découplé de la VOD.
ALTER TABLE "ImportRun" ADD COLUMN "scope" TEXT NOT NULL DEFAULT 'all';
