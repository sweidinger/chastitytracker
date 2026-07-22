-- Persona owns its seed + avatar; per-job seed + avatar->persona link
ALTER TABLE "AiPersona" ADD COLUMN "seed" INTEGER;
ALTER TABLE "AiPersona" ADD COLUMN "avatarPath" TEXT;
ALTER TABLE "GeneratedMedia" ADD COLUMN "seed" INTEGER;
ALTER TABLE "GeneratedMedia" ADD COLUMN "avatarPersonaId" TEXT;
