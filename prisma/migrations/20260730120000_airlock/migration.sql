-- Airlock-NFC (Weg A): der KG-Tracker als Frontend/Proxy gegen die externe Airlock-Instanz.
-- Zwei Tabellen: AirlockConfig (instanzweite Verbindung, EINE Zeile) + AirlockLock (Sicht auf ein
-- Lock + Zuordnung zu einem Sub). Dazu zwei Spalten am Entry, die einen per NFC-Airlock erfassten
-- Verschluss markieren. Siehe docs/AIRLOCK_NFC.md.

-- CreateTable
CREATE TABLE "AirlockConfig" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "baseUrl" TEXT,
    "apiKeyEnc" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AirlockLock" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "nfcUid" TEXT,
    "status" TEXT,
    "assignedUserId" TEXT,
    "assignedAt" DATETIME,
    "releasedAt" DATETIME,
    "lastSyncedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AirlockLock_assignedUserId_fkey" FOREIGN KEY ("assignedUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "AirlockLock_code_key" ON "AirlockLock"("code");

-- CreateIndex
CREATE INDEX "AirlockLock_assignedUserId_idx" ON "AirlockLock"("assignedUserId");

-- AlterTable
ALTER TABLE "Entry" ADD COLUMN "airlockCode" TEXT;
ALTER TABLE "Entry" ADD COLUMN "airlockUid" TEXT;
