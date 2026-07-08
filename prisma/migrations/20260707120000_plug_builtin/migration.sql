-- AlterTable: User — Anal-Plug Reinigung + Toilette Einstellungen
ALTER TABLE "User" ADD COLUMN "plugReinigungErlaubt" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "plugReinigungMaxMinuten" INTEGER NOT NULL DEFAULT 15;
ALTER TABLE "User" ADD COLUMN "plugReinigungMaxProTag" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "plugToiletteErlaubt" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "plugToiletteMaxMinuten" INTEGER NOT NULL DEFAULT 15;
ALTER TABLE "User" ADD COLUMN "plugToiletteMaxProTag" INTEGER NOT NULL DEFAULT 0;

-- Backfill: Plug-DeviceCategory für alle bestehenden User anlegen (idempotent via INSERT OR IGNORE)
INSERT OR IGNORE INTO "DeviceCategory" ("id", "userId", "name", "slug", "color", "icon", "isBuiltIn", "trackingEnabled", "requirePhoto", "allowVorgaben", "sortOrder", "createdAt")
SELECT 'plugcat_' || "id", "id", 'Anal-Plug', 'plug', 'cat-plum', 'Anchor', 1, 1, 0, 1, 1, datetime('now')
FROM "User";
