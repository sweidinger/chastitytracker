-- Dedicated LLM for image-prompt writing (separate from chat LLM)
ALTER TABLE "AiKeyholderConfig" ADD COLUMN "mediaLlmProvider" TEXT NOT NULL DEFAULT 'inherit';
ALTER TABLE "AiKeyholderConfig" ADD COLUMN "mediaLlmBaseUrl" TEXT;
ALTER TABLE "AiKeyholderConfig" ADD COLUMN "mediaLlmModel" TEXT;
