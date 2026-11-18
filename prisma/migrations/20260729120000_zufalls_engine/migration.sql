-- Zufalls-Engine: gewichtete Zufallsziehungen, die eine Konsequenz auslösen.
-- Drei Tabellen: Pool (Bündel gewichteter Optionen), Option (gewichtete Konsequenz-Vorlage),
-- Ziehung (eingefrorenes Protokoll einer erfolgten Ziehung + Verweis auf die erzeugte Konsequenz).

-- CreateTable
CREATE TABLE "ZufallsPool" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "aktiv" BOOLEAN NOT NULL DEFAULT true,
    "triggerType" TEXT NOT NULL DEFAULT 'MANUAL',
    "cooldownMin" INTEGER,
    "maxAddH" REAL,
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ZufallsPool_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ZufallsOption" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "poolId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "outcomeType" TEXT NOT NULL,
    "outcomeJson" TEXT,
    "sort" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "ZufallsOption_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "ZufallsPool" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ZufallsZiehung" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "poolId" TEXT NOT NULL,
    "optionId" TEXT NOT NULL,
    "optionLabel" TEXT NOT NULL,
    "outcomeType" TEXT NOT NULL,
    "drawnBy" TEXT NOT NULL,
    "drawnAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedRefType" TEXT,
    "appliedRefId" TEXT,
    "detail" TEXT,
    CONSTRAINT "ZufallsZiehung_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ZufallsZiehung_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "ZufallsPool" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ZufallsPool_userId_aktiv_idx" ON "ZufallsPool"("userId", "aktiv");

-- CreateIndex
CREATE INDEX "ZufallsOption_poolId_idx" ON "ZufallsOption"("poolId");

-- CreateIndex
CREATE INDEX "ZufallsZiehung_userId_drawnAt_idx" ON "ZufallsZiehung"("userId", "drawnAt");

-- CreateIndex
CREATE INDEX "ZufallsZiehung_poolId_idx" ON "ZufallsZiehung"("poolId");
