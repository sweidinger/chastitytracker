-- DropIndex
DROP INDEX "VerschlussAnforderung_deviceCategoryId_idx";

-- AlterTable
ALTER TABLE "Entry" ADD COLUMN "pauseDevice" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AiKeyholderConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "llmProvider" TEXT NOT NULL DEFAULT 'anthropic',
    "ollamaBaseUrl" TEXT,
    "ollamaModel" TEXT,
    "systemPrompt" TEXT,
    "currentPersonaId" TEXT,
    "cronExpression" TEXT,
    "lastRunAt" DATETIME,
    "nextRunAt" DATETIME,
    "randomIntervalMinMin" INTEGER,
    "randomIntervalMinMax" INTEGER,
    "anthropicApiKeyEnc" TEXT,
    "mediaEnabled" BOOLEAN NOT NULL DEFAULT false,
    "comfyUiBaseUrl" TEXT,
    "mediaPromptTemplates" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AiKeyholderConfig_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AiKeyholderConfig_currentPersonaId_fkey" FOREIGN KEY ("currentPersonaId") REFERENCES "AiPersona" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_AiKeyholderConfig" ("anthropicApiKeyEnc", "comfyUiBaseUrl", "createdAt", "cronExpression", "currentPersonaId", "enabled", "id", "lastRunAt", "llmProvider", "mediaEnabled", "mediaPromptTemplates", "nextRunAt", "ollamaBaseUrl", "ollamaModel", "randomIntervalMinMax", "randomIntervalMinMin", "systemPrompt", "updatedAt", "userId") SELECT "anthropicApiKeyEnc", "comfyUiBaseUrl", "createdAt", "cronExpression", "currentPersonaId", "enabled", "id", "lastRunAt", "llmProvider", "mediaEnabled", "mediaPromptTemplates", "nextRunAt", "ollamaBaseUrl", "ollamaModel", "randomIntervalMinMax", "randomIntervalMinMin", "systemPrompt", "updatedAt", "userId" FROM "AiKeyholderConfig";
DROP TABLE "AiKeyholderConfig";
ALTER TABLE "new_AiKeyholderConfig" RENAME TO "AiKeyholderConfig";
CREATE UNIQUE INDEX "AiKeyholderConfig_userId_key" ON "AiKeyholderConfig"("userId");
CREATE TABLE "new_KontrollAnforderung" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "kommentar" TEXT,
    "deadline" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fulfilledAt" DATETIME,
    "withdrawnAt" DATETIME,
    "wirksamAb" DATETIME,
    "benachrichtigtAt" DATETIME,
    "auto" BOOLEAN NOT NULL DEFAULT false,
    "requireCode" BOOLEAN NOT NULL DEFAULT true,
    "entryId" TEXT,
    CONSTRAINT "KontrollAnforderung_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "KontrollAnforderung_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "Entry" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_KontrollAnforderung" ("auto", "benachrichtigtAt", "code", "createdAt", "deadline", "entryId", "fulfilledAt", "id", "kommentar", "userId", "wirksamAb", "withdrawnAt") SELECT "auto", "benachrichtigtAt", "code", "createdAt", "deadline", "entryId", "fulfilledAt", "id", "kommentar", "userId", "wirksamAb", "withdrawnAt" FROM "KontrollAnforderung";
DROP TABLE "KontrollAnforderung";
ALTER TABLE "new_KontrollAnforderung" RENAME TO "KontrollAnforderung";
CREATE UNIQUE INDEX "KontrollAnforderung_entryId_key" ON "KontrollAnforderung"("entryId");
CREATE INDEX "KontrollAnforderung_userId_withdrawnAt_idx" ON "KontrollAnforderung"("userId", "withdrawnAt");
CREATE INDEX "KontrollAnforderung_userId_entryId_idx" ON "KontrollAnforderung"("userId", "entryId");
CREATE INDEX "KontrollAnforderung_wirksamAb_idx" ON "KontrollAnforderung"("wirksamAb");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
