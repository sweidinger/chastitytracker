-- Stichtag, ab dem das Orgasmus-Budget gilt (kein rueckwirkendes Werten von Orgasmen davor).
ALTER TABLE "User" ADD COLUMN "orgasmBudgetSetAt" DATETIME;
