-- Remplacement de TMDB par TVmaze + Fanart.tv (sources gratuites).
-- Renommage du cache + purge des payloads TMDB (URLs image.tmdb.org obsolètes).
ALTER TABLE "TmdbCache" RENAME TO "MetadataCache";
DELETE FROM "MetadataCache";
