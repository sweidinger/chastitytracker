-- Airlock-NFC Sicherheits-Feature: ein zugewiesenes Lock muss vom Sub per Tag-Scan verifiziert
-- werden (bestaetigt, dass der Tag liest), bevor es zum Verschluss nutzbar ist. NULL = unverifiziert.
ALTER TABLE "AirlockLock" ADD COLUMN "verifiedAt" DATETIME;
