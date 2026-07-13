-- Orgasmus-Ziel pro Session-Anforderung (überschreibt den Kategorie-Standard; KEINE|ERFORDERLICH|VERBOTEN).
ALTER TABLE "SessionAnforderung" ADD COLUMN "orgasmusZiel" TEXT NOT NULL DEFAULT 'KEINE';
