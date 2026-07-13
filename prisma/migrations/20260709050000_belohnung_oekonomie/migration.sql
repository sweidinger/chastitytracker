-- Belohnungs-Ökonomie: Guthaben verdienter Orgasmen + Belohnungs-Fenster-Flag + Gutschrift-Register.

-- Guthaben verfügbarer verdienter Orgasmen (Untergrenze 0, nie negativ — via Applikationslogik).
ALTER TABLE "User" ADD COLUMN "verdienteOrgasmen" INTEGER NOT NULL DEFAULT 0;

-- Markiert eine OrgasmusAnforderung als gewährtes Belohnungs-Fenster (GELEGENHEIT, vorgegebeneArt="Belohnung").
ALTER TABLE "OrgasmusAnforderung" ADD COLUMN "istBelohnung" BOOLEAN NOT NULL DEFAULT false;

-- Register bereits gutgeschriebener erreichter Trainingsziele (Dedupe "einmal pro Zeitraum je Ziel").
CREATE TABLE "OrgasmusBelohnungGutschrift" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "categoryId" TEXT,
    "periodType" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OrgasmusBelohnungGutschrift_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "OrgasmusBelohnungGutschrift_userId_idx" ON "OrgasmusBelohnungGutschrift"("userId");
CREATE UNIQUE INDEX "OrgasmusBelohnungGutschrift_userId_categoryId_periodType_periodKey_key" ON "OrgasmusBelohnungGutschrift"("userId", "categoryId", "periodType", "periodKey");
