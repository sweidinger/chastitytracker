-- CreateTable
CREATE TABLE "AiKeyholderConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "llmProvider" TEXT NOT NULL DEFAULT 'anthropic',
    "ollamaBaseUrl" TEXT,
    "ollamaModel" TEXT,
    "systemPrompt" TEXT,
    "cronExpression" TEXT,
    "lastRunAt" DATETIME,
    "mediaEnabled" BOOLEAN NOT NULL DEFAULT false,
    "comfyUiBaseUrl" TEXT,
    "mediaPromptTemplates" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AiKeyholderConfig_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AiKeyholderMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "mediaId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiKeyholderMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AiKeyholderMessage_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "GeneratedMedia" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GeneratedMedia" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "prompt" TEXT NOT NULL,
    "negativePrompt" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "comfyPromptId" TEXT,
    "filePath" TEXT,
    "assignedAt" DATETIME,
    "failedReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GeneratedMedia_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "KeyholderTask" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "mediaId" TEXT,
    "assignedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueAt" DATETIME,
    "completedAt" DATETIME,
    "responseText" TEXT,
    "aiReactionText" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "KeyholderTask_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "KeyholderTask_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "GeneratedMedia" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "AiKeyholderConfig_userId_key" ON "AiKeyholderConfig"("userId");

-- CreateIndex
CREATE INDEX "AiKeyholderMessage_userId_createdAt_idx" ON "AiKeyholderMessage"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "GeneratedMedia_userId_status_idx" ON "GeneratedMedia"("userId", "status");

-- CreateIndex
CREATE INDEX "KeyholderTask_userId_completedAt_idx" ON "KeyholderTask"("userId", "completedAt");

-- CreateIndex
CREATE INDEX "KeyholderTask_userId_assignedAt_idx" ON "KeyholderTask"("userId", "assignedAt" DESC);
