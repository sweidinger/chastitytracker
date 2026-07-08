-- AlterTable: User — Toiletten-Einstellungen
ALTER TABLE "User" ADD COLUMN "toiletteErlaubt" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "toiletteMaxMinuten" INTEGER NOT NULL DEFAULT 15;
ALTER TABLE "User" ADD COLUMN "toiletteMaxProTag" INTEGER NOT NULL DEFAULT 0;

-- AlterTable: Entry — Erektion-Flag auf OEFFNEN-Einträgen
ALTER TABLE "Entry" ADD COLUMN "erektionGemeldet" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable: VerschlussAnforderung — Toilette erlaubt während Sperrzeit
ALTER TABLE "VerschlussAnforderung" ADD COLUMN "toiletteErlaubt" BOOLEAN NOT NULL DEFAULT false;
