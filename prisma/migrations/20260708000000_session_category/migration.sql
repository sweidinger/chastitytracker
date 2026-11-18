-- AlterTable: DeviceCategory — Session-Kategorie-Felder (z.B. für Dildo-Kategorien)
ALTER TABLE "DeviceCategory" ADD COLUMN "isSessionCategory" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "DeviceCategory" ADD COLUMN "maxSessionMinutes" INTEGER NOT NULL DEFAULT 30;
ALTER TABLE "DeviceCategory" ADD COLUMN "requiresVideo" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable: Entry — SESSION_END-spezifische Felder
ALTER TABLE "Entry" ADD COLUMN "sessionGoalAchieved" BOOLEAN;
ALTER TABLE "Entry" ADD COLUMN "videoUrl" TEXT;

-- CreateTable: SessionAnforderung
CREATE TABLE "SessionAnforderung" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "deviceCategoryId" TEXT NOT NULL,
    "nachricht" TEXT,
    "endetAt" DATETIME,
    "fulfilledAt" DATETIME,
    "withdrawnAt" DATETIME,
    "sessionEndId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SessionAnforderung_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SessionAnforderung_deviceCategoryId_fkey" FOREIGN KEY ("deviceCategoryId") REFERENCES "DeviceCategory" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SessionAnforderung_sessionEndId_fkey" FOREIGN KEY ("sessionEndId") REFERENCES "Entry" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "SessionAnforderung_userId_idx" ON "SessionAnforderung"("userId");
CREATE INDEX "SessionAnforderung_userId_withdrawnAt_fulfilledAt_idx" ON "SessionAnforderung"("userId", "withdrawnAt", "fulfilledAt");
