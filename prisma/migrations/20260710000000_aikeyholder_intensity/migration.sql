-- Intensitäts-Regler (1–5) für die AI-Keyholderin: steuert Häufigkeit + Härte/Ton, nicht die Regeln.
ALTER TABLE "AiKeyholderConfig" ADD COLUMN "intensity" INTEGER NOT NULL DEFAULT 3;
