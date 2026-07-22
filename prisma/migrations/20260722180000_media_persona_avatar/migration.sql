-- Character consistency (persona anchor + seed) + generated avatar
ALTER TABLE "AiKeyholderConfig" ADD COLUMN "mediaPersonaAnchor" TEXT;
ALTER TABLE "AiKeyholderConfig" ADD COLUMN "mediaSeed" INTEGER;
ALTER TABLE "AiKeyholderConfig" ADD COLUMN "avatarPath" TEXT;
ALTER TABLE "GeneratedMedia" ADD COLUMN "isAvatar" BOOLEAN NOT NULL DEFAULT false;
