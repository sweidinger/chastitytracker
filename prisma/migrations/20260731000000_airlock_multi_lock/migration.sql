-- Airlock-NFC Multi-Lock:
--  (1) Die Keyholderin kann bei der Verschluss-Anforderung EIN bestimmtes (dem Sub zugewiesenes)
--      Lock vorgeben — der Sub muss dann beim Verschluss genau dieses per NFC scannen.
--  (2) Ausstehende Retire-Anfrage am Lock: ist der Airlock-Server beim Ablegen nicht erreichbar,
--      wird der Statuswechsel auf 'retired' per Reconcile beim naechsten Sync nachgezogen. Das Flag
--      schuetzt zugleich davor, dass der Sync ein lokal getoetetes Lock faelschlich auf 'active'
--      zuruecksetzt. Siehe docs/AIRLOCK_NFC.md.

-- AlterTable
ALTER TABLE "VerschlussAnforderung" ADD COLUMN "airlockCode" TEXT;

-- AlterTable
ALTER TABLE "AirlockLock" ADD COLUMN "retireRequestedAt" DATETIME;
