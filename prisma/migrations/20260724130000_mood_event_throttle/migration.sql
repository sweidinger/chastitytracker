-- Drossel-Status fuer Stimmungs-Ereignisse (Band beim letzten Ereignis + Zeitpunkt).
ALTER TABLE "AiKeyholderConfig" ADD COLUMN "lastMoodEventBand" TEXT;
ALTER TABLE "AiKeyholderConfig" ADD COLUMN "lastMoodEventAt" DATETIME;
