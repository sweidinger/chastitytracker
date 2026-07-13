-- Strafen-Erledigung: Sub meldet Erledigung (optional mit Nachweis), Keyholderin bestätigt oder lehnt ab
ALTER TABLE "StrafeRecord" ADD COLUMN "gemeldetAt" DATETIME;
ALTER TABLE "StrafeRecord" ADD COLUMN "nachweisUrl" TEXT;
ALTER TABLE "StrafeRecord" ADD COLUMN "erledigungNotiz" TEXT;
ALTER TABLE "StrafeRecord" ADD COLUMN "ablehnungGrund" TEXT;
