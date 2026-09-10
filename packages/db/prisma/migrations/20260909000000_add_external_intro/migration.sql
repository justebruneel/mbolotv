-- Fenêtre d'intro des titres externes (secondes, null-ables) : saisie en
-- console propriétaire, le Player affiche « Sauter l'intro » quand la
-- position courante est dans [introStartSec, introEndSec).
ALTER TABLE "ExternalTitle" ADD COLUMN "introStartSec" DOUBLE PRECISION,
ADD COLUMN "introEndSec" DOUBLE PRECISION;
