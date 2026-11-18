-- Hoechster bereits gemeldeter orgasmusfreier Rekord (in Tagen) — verhindert wiederholte Meilenstein-Pushes.
ALTER TABLE "User" ADD COLUMN "denialRecordDays" INTEGER NOT NULL DEFAULT 0;
