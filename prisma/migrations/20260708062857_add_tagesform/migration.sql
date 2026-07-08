-- CreateTable
CREATE TABLE "Tagesform" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "datum" DATETIME NOT NULL,
    "erregung" INTEGER NOT NULL,
    "koerper" INTEGER NOT NULL,
    "headspace" INTEGER NOT NULL,
    "notiz" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Tagesform_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Tagesform_userId_datum_key" ON "Tagesform"("userId", "datum");

-- CreateIndex
CREATE INDEX "Tagesform_userId_datum_idx" ON "Tagesform"("userId", "datum" DESC);
