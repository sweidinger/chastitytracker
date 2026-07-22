-- Medien-Backend pro Nutzer wählbar: "comfyui" (self-hosted) | "novita" (gehostete Async-API).
-- mediaApiKeyEnc = verschlüsselter Provider-API-Key (Novita), mediaModelName = Checkpoint (model_name).
ALTER TABLE "AiKeyholderConfig" ADD COLUMN "mediaProvider" TEXT NOT NULL DEFAULT 'comfyui';
ALTER TABLE "AiKeyholderConfig" ADD COLUMN "mediaApiKeyEnc" TEXT;
ALTER TABLE "AiKeyholderConfig" ADD COLUMN "mediaModelName" TEXT;
