-- Ajout de la fin de diffusion estimée d'un match (détection EPG)
ALTER TABLE "Match" ADD COLUMN "endsAt" DATETIME;