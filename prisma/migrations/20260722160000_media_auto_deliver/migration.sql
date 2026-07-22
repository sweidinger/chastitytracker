-- On-demand chat delivery for generated media
ALTER TABLE "GeneratedMedia" ADD COLUMN "autoDeliver" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "GeneratedMedia" ADD COLUMN "deliverMessage" TEXT;
