-- Körperregion je Geräte-Kategorie für die anatomische Exklusivität (zwei Geräte derselben
-- Region != "other" können nicht gleichzeitig aktiv sein). Built-ins vorbelegen: KG=genital, Plug=anal.
ALTER TABLE "DeviceCategory" ADD COLUMN "region" TEXT NOT NULL DEFAULT 'other';
UPDATE "DeviceCategory" SET "region" = 'genital' WHERE "slug" = 'kg';
UPDATE "DeviceCategory" SET "region" = 'anal' WHERE "slug" = 'plug';
