-- Favoris « films & séries » (titres externes, lecteurs tiers) — miroir de
-- VodFavorite : la clé appartient à l'appareil (x-device-id), la FK pointe
-- vers ExternalTitle. La suppression d'un titre emporte ses favoris.
CREATE TABLE "ExternalFavorite" (
    "deviceId" TEXT NOT NULL,
    "externalTitleId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExternalFavorite_pkey" PRIMARY KEY ("deviceId","externalTitleId")
);

CREATE INDEX "ExternalFavorite_deviceId_createdAt_idx" ON "ExternalFavorite"("deviceId", "createdAt");

ALTER TABLE "ExternalFavorite" ADD CONSTRAINT "ExternalFavorite_externalTitleId_fkey" FOREIGN KEY ("externalTitleId") REFERENCES "ExternalTitle"("id") ON DELETE CASCADE ON UPDATE CASCADE;