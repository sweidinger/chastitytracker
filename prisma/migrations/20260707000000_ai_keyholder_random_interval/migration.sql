-- AlterTable: add random interval scheduling fields to AiKeyholderConfig
ALTER TABLE "AiKeyholderConfig" ADD COLUMN "nextRunAt" DATETIME;
ALTER TABLE "AiKeyholderConfig" ADD COLUMN "randomIntervalMinMin" INTEGER;
ALTER TABLE "AiKeyholderConfig" ADD COLUMN "randomIntervalMinMax" INTEGER;
