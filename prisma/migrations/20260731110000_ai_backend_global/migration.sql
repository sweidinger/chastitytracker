-- KI-Backend global: neues Singleton AiBackendConfig (analog AirlockConfig). Die Backend-Verbindung
-- der AI-Keyholderin wandert von PER-USER (AiKeyholderConfig) auf INSTANZWEIT. Seed: aus der
-- reichhaltigsten bestehenden AiKeyholderConfig-Zeile (mit gesetzten Backend-Werten, neueste).
-- Die per-User-Backend-Spalten bleiben (deprecated) liegen, werden aber nicht mehr gelesen/geschrieben.
CREATE TABLE "AiBackendConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "AiBackendConfig" (
    "id","llmProvider","ollamaBaseUrl","ollamaModel","anthropicApiKeyEnc",
    "mediaProvider","comfyUiBaseUrl","mediaApiKeyEnc","mediaModelName",
    "mediaLlmProvider","mediaLlmBaseUrl","mediaLlmModel"
)
SELECT 'singleton',
    COALESCE("llmProvider",'anthropic'), "ollamaBaseUrl", "ollamaModel", "anthropicApiKeyEnc",
    COALESCE("mediaProvider",'comfyui'), "comfyUiBaseUrl", "mediaApiKeyEnc", "mediaModelName",
    COALESCE("mediaLlmProvider",'inherit'), "mediaLlmBaseUrl", "mediaLlmModel"
FROM "AiKeyholderConfig"
ORDER BY (CASE WHEN "ollamaBaseUrl" IS NOT NULL OR "anthropicApiKeyEnc" IS NOT NULL
                 OR "comfyUiBaseUrl" IS NOT NULL OR "mediaApiKeyEnc" IS NOT NULL THEN 0 ELSE 1 END),
         "updatedAt" DESC
LIMIT 1;
