-- Proaktive Check-ins der AI-Keyholderin (reine Sozial-Nachrichten ohne Aktion):
-- proactiveCheckinMinHours = Mindestabstand in Stunden zwischen zwei Check-ins (0 = deaktiviert),
-- lastCheckinAt = Zeitstempel des letzten Check-ins (Drossel-Basis). Getrennt von randomInterval* (Lauf-Kadenz).
ALTER TABLE "AiKeyholderConfig" ADD COLUMN "proactiveCheckinMinHours" INTEGER NOT NULL DEFAULT 24;
ALTER TABLE "AiKeyholderConfig" ADD COLUMN "lastCheckinAt" DATETIME;
