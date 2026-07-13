-- Entry: Flag für "falsches Gerät" (Verschluss mit anderem als dem angeforderten Gerät).
-- Wird im Strafbuch nur noch ERKANNT (kein automatischer StrafeRecord mehr).
ALTER TABLE "Entry" ADD COLUMN "falschesGeraet" BOOLEAN NOT NULL DEFAULT false;
