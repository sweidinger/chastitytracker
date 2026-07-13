-- Upstream-Merge trublue-2 v4.50.4: Sprache pro Konto + zweistufige Kontroll-Eskalation

-- User: UI-/Benachrichtigungs-Sprache pro Konto ("de" | "en")
ALTER TABLE "User" ADD COLUMN "locale" TEXT NOT NULL DEFAULT 'de';

-- Entry: Herkunfts-Marker ("user" | "system"); "system" = automatisch erzeugte OEFFNEN-Entry
-- der Kontroll-Eskalation (Stufe 2)
ALTER TABLE "Entry" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'user';

-- KontrollAnforderung: Eskalations-Stufen
ALTER TABLE "KontrollAnforderung" ADD COLUMN "benachrichtigtReminderAt" DATETIME;
ALTER TABLE "KontrollAnforderung" ADD COLUMN "autoMarkedRemovedAt" DATETIME;
ALTER TABLE "KontrollAnforderung" ADD COLUMN "autoMarkedEntryId" TEXT;

CREATE UNIQUE INDEX "KontrollAnforderung_autoMarkedEntryId_key"
  ON "KontrollAnforderung"("autoMarkedEntryId");
