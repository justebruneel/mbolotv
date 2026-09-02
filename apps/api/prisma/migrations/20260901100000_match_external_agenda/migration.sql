-- Section « À la une » football : les matchs d'agenda (TheSportsDB) portent
-- leur identifiant externe pour l'idempotence des imports, + logos équipes.
ALTER TABLE "Match" ADD COLUMN "externalId" TEXT;
ALTER TABLE "Match" ADD COLUMN "homeTeamLogo" TEXT;
ALTER TABLE "Match" ADD COLUMN "awayTeamLogo" TEXT;
CREATE UNIQUE INDEX "Match_externalId_key" ON "Match"("externalId");
