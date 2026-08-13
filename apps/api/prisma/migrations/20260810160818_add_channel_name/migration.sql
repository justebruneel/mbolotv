/*
  Warnings:

  - Added the required column `name` to the `Channel` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Channel" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "canonicalName" TEXT NOT NULL,
    "normalizedKey" TEXT NOT NULL,
    "tvgId" TEXT,
    "country" TEXT,
    "logoKey" TEXT,
    "categoryId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Channel_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Channel" ("canonicalName", "categoryId", "country", "createdAt", "id", "logoKey", "normalizedKey", "tvgId") SELECT "canonicalName", "categoryId", "country", "createdAt", "id", "logoKey", "normalizedKey", "tvgId" FROM "Channel";
DROP TABLE "Channel";
ALTER TABLE "new_Channel" RENAME TO "Channel";
CREATE UNIQUE INDEX "Channel_normalizedKey_key" ON "Channel"("normalizedKey");
CREATE INDEX "Channel_categoryId_idx" ON "Channel"("categoryId");
CREATE INDEX "Channel_tvgId_idx" ON "Channel"("tvgId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
