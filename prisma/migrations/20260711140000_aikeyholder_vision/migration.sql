-- AI-Keyholderin: Vision (Fotos werden dem Modell mitgeschickt)
ALTER TABLE "AiKeyholderConfig" ADD COLUMN "visionEnabled" BOOLEAN NOT NULL DEFAULT true;
