-- AlterTable: add orgasmusZiel to DeviceCategory (default "KEINE")
ALTER TABLE "DeviceCategory" ADD COLUMN "orgasmusZiel" TEXT NOT NULL DEFAULT 'KEINE';
