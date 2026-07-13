-- Nur bei orgasmusZiel=ERFORDERLICH relevant: der geforderte Orgasmus muss ruiniert sein.
ALTER TABLE "SessionAnforderung" ADD COLUMN "orgasmusRuiniert" BOOLEAN NOT NULL DEFAULT false;
