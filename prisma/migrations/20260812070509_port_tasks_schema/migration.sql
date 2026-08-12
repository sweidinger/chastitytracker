-- AlterTable
ALTER TABLE "User" ADD COLUMN "autoInspectionPlannedFor" DATETIME;

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "holdUntil" DATETIME NOT NULL,
    "startGraceMin" INTEGER NOT NULL DEFAULT 30,
    "isPunishment" BOOLEAN NOT NULL DEFAULT false,
    "penaltyReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "completionNote" TEXT,
    "withdrawnAt" DATETIME,
    "resultNotifiedAt" DATETIME,
    CONSTRAINT "Task_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TaskProof" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "description" TEXT NOT NULL,
    "requireCode" BOOLEAN NOT NULL DEFAULT false,
    "code" TEXT,
    "imageUrl" TEXT,
    "imageExifTime" DATETIME,
    "submittedAt" DATETIME,
    "verifikationStatus" TEXT,
    "verifikationReason" TEXT,
    "verifikationReasonDetected" TEXT,
    "reviewedAt" DATETIME,
    "reviewAccepted" BOOLEAN,
    "reviewNote" TEXT,
    CONSTRAINT "TaskProof_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TaskRequirement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "categoryId" TEXT,
    "deviceId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "TaskRequirement_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TaskRequirement_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "DeviceCategory" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "TaskRequirement_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "subjectUserId" TEXT NOT NULL,
    "senderKind" TEXT NOT NULL,
    "audience" TEXT NOT NULL,
    "bodyKey" TEXT,
    "bodyParams" TEXT,
    "body" TEXT,
    "refEntityType" TEXT,
    "refEntityId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Message_subjectUserId_fkey" FOREIGN KEY ("subjectUserId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MessageRead" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "readAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MessageRead_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MessageRead_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AdminPasswordChange" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "subUserId" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "adminUsername" TEXT NOT NULL,
    "via" TEXT NOT NULL,
    "actorUserId" TEXT,
    "sperrzeitId" TEXT,
    "sperrzeitEndetAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdminPasswordChange_subUserId_fkey" FOREIGN KEY ("subUserId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AiBackendConfig" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton',
    "llmProvider" TEXT NOT NULL DEFAULT 'anthropic',
    "ollamaBaseUrl" TEXT,
    "ollamaModel" TEXT,
    "anthropicApiKeyEnc" TEXT,
    "mediaProvider" TEXT NOT NULL DEFAULT 'comfyui',
    "comfyUiBaseUrl" TEXT,
    "mediaApiKeyEnc" TEXT,
    "mediaModelName" TEXT,
    "mediaLlmProvider" TEXT NOT NULL DEFAULT 'inherit',
    "mediaLlmBaseUrl" TEXT,
    "mediaLlmModel" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_AiBackendConfig" ("anthropicApiKeyEnc", "comfyUiBaseUrl", "createdAt", "id", "llmProvider", "mediaApiKeyEnc", "mediaLlmBaseUrl", "mediaLlmModel", "mediaLlmProvider", "mediaModelName", "mediaProvider", "ollamaBaseUrl", "ollamaModel", "updatedAt") SELECT "anthropicApiKeyEnc", "comfyUiBaseUrl", "createdAt", "id", "llmProvider", "mediaApiKeyEnc", "mediaLlmBaseUrl", "mediaLlmModel", "mediaLlmProvider", "mediaModelName", "mediaProvider", "ollamaBaseUrl", "ollamaModel", "updatedAt" FROM "AiBackendConfig";
DROP TABLE "AiBackendConfig";
ALTER TABLE "new_AiBackendConfig" RENAME TO "AiBackendConfig";
CREATE TABLE "new_StrafeRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "offenseType" TEXT NOT NULL,
    "refId" TEXT NOT NULL,
    "bestraftDatum" DATETIME NOT NULL,
    "notiz" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PUNISHED',
    "reason" TEXT,
    "judgedBy" TEXT,
    "erledigtAt" DATETIME,
    "gemeldetAt" DATETIME,
    "nachweisUrl" TEXT,
    "erledigungNotiz" TEXT,
    "ablehnungGrund" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "taskId" TEXT,
    CONSTRAINT "StrafeRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StrafeRecord_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_StrafeRecord" ("ablehnungGrund", "bestraftDatum", "createdAt", "erledigtAt", "erledigungNotiz", "gemeldetAt", "id", "judgedBy", "nachweisUrl", "notiz", "offenseType", "reason", "refId", "status", "userId") SELECT "ablehnungGrund", "bestraftDatum", "createdAt", "erledigtAt", "erledigungNotiz", "gemeldetAt", "id", "judgedBy", "nachweisUrl", "notiz", "offenseType", "reason", "refId", "status", "userId" FROM "StrafeRecord";
DROP TABLE "StrafeRecord";
ALTER TABLE "new_StrafeRecord" RENAME TO "StrafeRecord";
CREATE UNIQUE INDEX "StrafeRecord_refId_key" ON "StrafeRecord"("refId");
CREATE INDEX "StrafeRecord_userId_idx" ON "StrafeRecord"("userId");
CREATE INDEX "StrafeRecord_taskId_idx" ON "StrafeRecord"("taskId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Task_userId_withdrawnAt_completedAt_idx" ON "Task"("userId", "withdrawnAt", "completedAt");

-- CreateIndex
CREATE INDEX "Task_userId_holdUntil_idx" ON "Task"("userId", "holdUntil");

-- CreateIndex
CREATE INDEX "Task_resultNotifiedAt_holdUntil_idx" ON "Task"("resultNotifiedAt", "holdUntil");

-- CreateIndex
CREATE INDEX "TaskProof_taskId_sortOrder_idx" ON "TaskProof"("taskId", "sortOrder");

-- CreateIndex
CREATE INDEX "TaskRequirement_taskId_idx" ON "TaskRequirement"("taskId");

-- CreateIndex
CREATE INDEX "TaskRequirement_categoryId_idx" ON "TaskRequirement"("categoryId");

-- CreateIndex
CREATE INDEX "TaskRequirement_deviceId_idx" ON "TaskRequirement"("deviceId");

-- CreateIndex
CREATE INDEX "Message_subjectUserId_audience_createdAt_idx" ON "Message"("subjectUserId", "audience", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MessageRead_messageId_userId_key" ON "MessageRead"("messageId", "userId");

-- CreateIndex
CREATE INDEX "AdminPasswordChange_subUserId_createdAt_idx" ON "AdminPasswordChange"("subUserId", "createdAt");
