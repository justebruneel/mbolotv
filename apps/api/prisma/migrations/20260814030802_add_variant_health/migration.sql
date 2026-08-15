-- AlterTable
ALTER TABLE "StreamVariant" ADD COLUMN "healthCheckedAt" DATETIME;
ALTER TABLE "StreamVariant" ADD COLUMN "healthStatus" TEXT;
ALTER TABLE "StreamVariant" ADD COLUMN "lastPlayedAt" DATETIME;

-- CreateIndex
CREATE INDEX "StreamVariant_lastPlayedAt_idx" ON "StreamVariant"("lastPlayedAt");
