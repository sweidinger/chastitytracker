-- Session-Anforderung verfeinern: Mindestdauer, Nachweis-Pflicht, geplante Auslösung, bestimmtes Gerät.
ALTER TABLE "SessionAnforderung" ADD COLUMN "minMinuten" INTEGER;
ALTER TABLE "SessionAnforderung" ADD COLUMN "requireVideo" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SessionAnforderung" ADD COLUMN "wirksamAb" DATETIME;
ALTER TABLE "SessionAnforderung" ADD COLUMN "deviceId" TEXT;
