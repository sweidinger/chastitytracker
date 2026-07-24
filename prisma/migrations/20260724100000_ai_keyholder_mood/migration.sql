-- Beziehungs-/Stimmungsstand der KI-Keyholderin (0-100, 50 = neutral) + Zeitpunkt der letzten Aenderung.
ALTER TABLE "AiKeyholderConfig" ADD COLUMN "moodScore" INTEGER NOT NULL DEFAULT 50;
ALTER TABLE "AiKeyholderConfig" ADD COLUMN "moodUpdatedAt" DATETIME;
