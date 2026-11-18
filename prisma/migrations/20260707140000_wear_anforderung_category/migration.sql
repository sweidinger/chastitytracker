-- AlterTable: VerschlussAnforderung — deviceCategoryId für Plug-Anforderungen / Plug-Sperrzeiten
ALTER TABLE "VerschlussAnforderung" ADD COLUMN "deviceCategoryId" TEXT REFERENCES "DeviceCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "VerschlussAnforderung_deviceCategoryId_idx" ON "VerschlussAnforderung"("deviceCategoryId");
