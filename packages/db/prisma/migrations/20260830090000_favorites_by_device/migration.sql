-- Les favoris passent du profil (jamais utilisé) à l'appareil (x-device-id).
DROP TABLE "Favorite";

CREATE TABLE "Favorite" (
    "deviceId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Favorite_pkey" PRIMARY KEY ("deviceId","channelId")
);

CREATE INDEX "Favorite_deviceId_createdAt_idx" ON "Favorite"("deviceId", "createdAt");

ALTER TABLE "Favorite" ADD CONSTRAINT "Favorite_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
