-- Device: Größen-Reihenfolge innerhalb der Kategorie (z.B. Plug). Kleiner = kleiner.
-- Für die Strafaktion "nächstgrößeres Gerät anfordern".
ALTER TABLE "Device" ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;
