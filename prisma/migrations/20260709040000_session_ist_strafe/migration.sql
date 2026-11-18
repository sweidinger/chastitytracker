-- SessionAnforderung: Flag "als Strafe angeordnet" (Pflicht-Session als Strafe).
-- Ermöglicht die strengere Eskalation, wenn eine verhängte Straf-Session ignoriert wird.
ALTER TABLE "SessionAnforderung" ADD COLUMN "istStrafe" BOOLEAN NOT NULL DEFAULT false;
