-- Repli iframe : les lecteurs sans extracteur (premium/fsvid, vidzy, filmoon,
-- netu…) sont stockés avec mode='iframe' (lus en iframe côté lecteur) au lieu
-- d'être rejetés. 'direct' = résolu par un extracteur via /api/x/play.
ALTER TABLE "ExternalSource" ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'direct';
