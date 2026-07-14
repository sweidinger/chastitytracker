-- Wiederherstellung der Fork-Spalten, die upstreams Rebuild-Migration
-- 20260709140000_add_inspection_escalation aus User/Entry/KontrollAnforderung entfernt hat.
-- Upstream nutzt das SQLite-Rebuild-Pattern (CREATE new_X / INSERT SELECT / DROP X) und kopiert
-- dabei nur die Spalten, die IHR Schema kennt — alle Fork-Spalten fallen heraus.
-- Struktur wird wiederhergestellt; die Werte der geloeschten Spalten sind nicht rekonstruierbar
-- und starten auf ihren Defaults.

ALTER TABLE "User" ADD COLUMN "toiletteErlaubt" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "toiletteMaxMinuten" INTEGER NOT NULL DEFAULT 15;
ALTER TABLE "User" ADD COLUMN "toiletteMaxProTag" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "plugReinigungErlaubt" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "plugReinigungMaxMinuten" INTEGER NOT NULL DEFAULT 15;
ALTER TABLE "User" ADD COLUMN "plugReinigungMaxProTag" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "plugReinigungsFenster" TEXT;
ALTER TABLE "User" ADD COLUMN "plugToiletteMaxMinuten" INTEGER NOT NULL DEFAULT 15;
ALTER TABLE "User" ADD COLUMN "verdienteOrgasmen" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Entry" ADD COLUMN "erektionGemeldet" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Entry" ADD COLUMN "falschesGeraet" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Entry" ADD COLUMN "sessionGoalAchieved" BOOLEAN;
ALTER TABLE "Entry" ADD COLUMN "videoUrl" TEXT;
ALTER TABLE "Entry" ADD COLUMN "pauseDevice" TEXT;
ALTER TABLE "KontrollAnforderung" ADD COLUMN "requireCode" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "KontrollAnforderung" ADD COLUMN "device" TEXT;
