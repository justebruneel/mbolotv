/*
  Warnings:

  - You are about to drop the column `tokenHash` on the `OwnerSession` table. All the data in the column will be lost.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_OwnerSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "userAgent" TEXT,
    "ipHash" TEXT,
    "mfaVerifiedAt" DATETIME NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "revokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OwnerSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_OwnerSession" ("createdAt", "expiresAt", "id", "ipHash", "mfaVerifiedAt", "revokedAt", "userAgent", "userId") SELECT "createdAt", "expiresAt", "id", "ipHash", "mfaVerifiedAt", "revokedAt", "userAgent", "userId" FROM "OwnerSession";
DROP TABLE "OwnerSession";
ALTER TABLE "new_OwnerSession" RENAME TO "OwnerSession";
CREATE INDEX "OwnerSession_userId_expiresAt_idx" ON "OwnerSession"("userId", "expiresAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
