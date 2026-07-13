-- Belohnungs-Ökonomie: Ereignis-Protokoll (Kontoauszug) für die Belohnungs-/Straf-Historie
CREATE TABLE "BelohnungEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "delta" INTEGER NOT NULL DEFAULT 0,
    "balanceAfter" INTEGER NOT NULL DEFAULT 0,
    "detail" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BelohnungEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "BelohnungEvent_userId_createdAt_idx" ON "BelohnungEvent"("userId", "createdAt");
