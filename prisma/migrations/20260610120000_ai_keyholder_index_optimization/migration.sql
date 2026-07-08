-- AI Keyholder Index-Optimierungen (Code-Review 2026-06-10)
--
-- 1. AiKeyholderMessage: Composite index für userId + role + createdAt
--    (ersetzt den alten [userId, createdAt]-Index — deckt role-Filter für History-Queries ab)
-- 2. KeyholderTask: Composite index für userId + completedAt + assignedAt
--    (ersetzt die beiden Einzel-Indizes — deckt open-tasks query ab)

-- Drop old AiKeyholderMessage index (was [userId, createdAt])
DROP INDEX IF EXISTS "AiKeyholderMessage_userId_createdAt_idx";

-- New composite index: userId + role + createdAt
CREATE INDEX IF NOT EXISTS "AiKeyholderMessage_userId_role_createdAt_idx"
  ON "AiKeyholderMessage" ("userId", "role", "createdAt" DESC);

-- Drop old KeyholderTask indexes
DROP INDEX IF EXISTS "KeyholderTask_userId_completedAt_idx";
DROP INDEX IF EXISTS "KeyholderTask_userId_assignedAt_idx";

-- New composite index: userId + completedAt + assignedAt
CREATE INDEX IF NOT EXISTS "KeyholderTask_userId_completedAt_assignedAt_idx"
  ON "KeyholderTask" ("userId", "completedAt", "assignedAt" DESC);
