-- Orgasmus-Budget: max. Anzahl zaehlbarer Orgasmen pro Zeitraum (WOCHE|MONAT). NULL = kein Budget/aus.
ALTER TABLE "User" ADD COLUMN "orgasmBudget" INTEGER;
ALTER TABLE "User" ADD COLUMN "orgasmBudgetPeriode" TEXT NOT NULL DEFAULT 'WOCHE';
