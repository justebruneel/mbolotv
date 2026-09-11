-- Durcissement du mur d'accès (voir workers/mbolo-tv-api/src/access.js).

-- Révocation par appareil : couper un appareil précis sans effacer le code,
-- pour que la console garde la trace de l'émission (contrairement à la
-- suppression du code, qui efface tout en cascade).
ALTER TABLE "DeviceGrant" ADD COLUMN "revokedAt" TIMESTAMP(3);

-- "maxDevices" n'était lu nulle part, et ne pouvait pas l'être :
-- DeviceGrant.accessCodeId est UNIQUE, donc un code ne peut structurellement
-- lier qu'un seul appareil. Le champ contredisait la réalité du modèle
-- (« un code, un appareil ») et la console qui l'affiche.
ALTER TABLE "AccessCode" DROP COLUMN "maxDevices";

-- Journal des tentatives de /access/redeem : rate limit persistant (comptage
-- par IP et par appareil) et traçabilité des bruteforce. Aucune clé étrangère :
-- on journalise aussi les tentatives sur des codes inexistants.
CREATE TABLE "AccessAttempt" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT,
    "deviceHash" TEXT,
    "ipHash" TEXT,
    "outcome" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AccessAttempt_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AccessAttempt_deviceHash_createdAt_idx" ON "AccessAttempt"("deviceHash", "createdAt");
CREATE INDEX "AccessAttempt_ipHash_createdAt_idx" ON "AccessAttempt"("ipHash", "createdAt");
CREATE INDEX "AccessAttempt_createdAt_idx" ON "AccessAttempt"("createdAt");
