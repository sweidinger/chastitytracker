-- Bereinigung: Video-Beweis-Pflicht + Orgasmus-Ziel werden nur noch pro „Session anfordern" gesetzt,
-- nicht mehr an der Kategorie. Bestehende Session-Kategorien auf die Standardwerte zurücksetzen.
UPDATE "DeviceCategory" SET "requiresVideo" = false, "orgasmusZiel" = 'KEINE' WHERE "isSessionCategory" = true;
