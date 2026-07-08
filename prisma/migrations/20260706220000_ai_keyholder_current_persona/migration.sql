-- AlterTable: add currentPersonaId to AiKeyholderConfig
ALTER TABLE "AiKeyholderConfig" ADD COLUMN "currentPersonaId" TEXT;

-- AddForeignKey
CREATE INDEX "AiKeyholderConfig_currentPersonaId_idx" ON "AiKeyholderConfig"("currentPersonaId");
