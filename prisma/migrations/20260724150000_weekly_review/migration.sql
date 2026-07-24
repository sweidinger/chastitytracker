-- Zeitpunkt des letzten woechentlichen Rueckblicks der KI-Keyholderin (Drossel).
ALTER TABLE "AiKeyholderConfig" ADD COLUMN "lastWeeklyReviewAt" DATETIME;
