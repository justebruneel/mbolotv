-- Add owner-controlled publication flags.
ALTER TABLE "Category" ADD COLUMN "isVisible" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Channel" ADD COLUMN "isVisible" BOOLEAN NOT NULL DEFAULT true;
CREATE INDEX "Category_parentId_isVisible_idx" ON "Category"("parentId", "isVisible");
CREATE INDEX "Channel_categoryId_isVisible_idx" ON "Channel"("categoryId", "isVisible");

-- One-time access codes and one-device grants.
CREATE TABLE "AccessCode" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "codeLast4" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'STANDARD',
    "durationHours" INTEGER NOT NULL,
    "maxDevices" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    CONSTRAINT "AccessCode_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AccessCode_codeHash_key" ON "AccessCode"("codeHash");
CREATE INDEX "AccessCode_createdById_active_idx" ON "AccessCode"("createdById", "active");

CREATE TABLE "DeviceGrant" (
    "id" TEXT NOT NULL,
    "accessCodeId" TEXT NOT NULL,
    "deviceHash" TEXT NOT NULL,
    "userAgent" TEXT,
    "ipHash" TEXT,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DeviceGrant_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DeviceGrant_accessCodeId_key" ON "DeviceGrant"("accessCodeId");
CREATE INDEX "DeviceGrant_deviceHash_expiresAt_idx" ON "DeviceGrant"("deviceHash", "expiresAt");

ALTER TABLE "AccessCode" ADD CONSTRAINT "AccessCode_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DeviceGrant" ADD CONSTRAINT "DeviceGrant_accessCodeId_fkey" FOREIGN KEY ("accessCodeId") REFERENCES "AccessCode"("id") ON DELETE CASCADE ON UPDATE CASCADE;
