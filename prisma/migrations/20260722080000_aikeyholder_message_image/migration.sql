-- Vom Sub im Keyholder-Chat vorgelegtes/hochgeladenes Bild (Vision). Optional; Dateiname unter
-- data/uploads. Haelt ein gezeigtes Foto im Verlauf sichtbar und fuer die KI erneut ladbar.
ALTER TABLE "AiKeyholderMessage" ADD COLUMN "imageUrl" TEXT;
