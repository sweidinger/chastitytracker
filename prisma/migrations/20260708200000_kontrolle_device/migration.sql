-- AlterTable: add device column to KontrollAnforderung (nullable, no default needed)
ALTER TABLE "KontrollAnforderung" ADD COLUMN "device" TEXT;
