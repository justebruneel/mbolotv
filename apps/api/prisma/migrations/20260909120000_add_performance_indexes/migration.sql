-- Index pour la recherche par pays (countries() + filtre list(q.country)).
-- CreateIndex
CREATE INDEX "Channel_country_idx" ON "Channel"("country");

-- Index pour le scoring de santé (scan des variants dégradés/à re-tester).
-- CreateIndex
CREATE INDEX "StreamVariant_healthStatus_healthCheckedAt_idx" ON "StreamVariant"("healthStatus", "healthCheckedAt");

-- Index composite pour findNowPlaying (WHERE channelId = ? AND startsAt <= ? AND endsAt >= ?).
-- CreateIndex
CREATE INDEX "EpgProgramme_channelId_startsAt_endsAt_idx" ON "EpgProgramme"("channelId", "startsAt", "endsAt");

-- Index pour les scans de plage temporelle globaux (stats/EPG overlap).
-- CreateIndex
CREATE INDEX "EpgProgramme_startsAt_endsAt_idx" ON "EpgProgramme"("startsAt", "endsAt");