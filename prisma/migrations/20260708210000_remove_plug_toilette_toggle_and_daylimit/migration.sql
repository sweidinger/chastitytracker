-- Plug-Toilette ist ab jetzt immer erlaubt und unbegrenzt.
-- Entfernt die nicht mehr benoetigten Spalten (plugToiletteMaxMinuten bleibt).
ALTER TABLE "User" DROP COLUMN "plugToiletteErlaubt";
ALTER TABLE "User" DROP COLUMN "plugToiletteMaxProTag";
