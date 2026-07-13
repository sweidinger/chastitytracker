-- OrgasmusAnforderung: Flag "als Strafe angeordnet" (z.B. ruinierter Orgasmus als Pflicht).
-- Ermöglicht die strengere Eskalation, wenn eine verhängte Straf-Anweisung ignoriert wird.
ALTER TABLE "OrgasmusAnforderung" ADD COLUMN "istStrafe" BOOLEAN NOT NULL DEFAULT false;
