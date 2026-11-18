-- periodKey-Monatsbug (bestand seit Einfuehrung der Belohnungs-Oekonomie im Fork).
-- `periodKeyFor` baute den String-Key aus `tzDateParts().month`, der 0-indexiert ist (JS-Konvention),
-- ohne +1 — jeder gespeicherte periodKey trug daher den VORMONAT (z.B. 2026-06-19 fuer den 19. Juli).
-- Funktional harmlos (die Zuordnung Tag<->Key blieb eindeutig, kein Doppel-Credit), aber semantisch
-- falsch. Der Code-Fix (pad(month+1)) erzeugt ab jetzt korrekte Keys; diese Migration hebt die
-- Altbestaende auf denselben Stand, damit computeBelohnbar sie weiterhin als "schon gutgeschrieben"
-- erkennt und nichts doppelt bucht.
--
-- +1 auf den zweistelligen Monatsteil je Format. Grenzfaelle: "00"->"01" (Januar), "11"->"12"
-- (Dezember). Kein Jahresuebertrag noetig, da der Bug den Monat um genau 1 nach unten schob
-- (echter Monat 1..12 -> Bug 0..11 -> +1 zurueck auf 1..12). year-Keys tragen keinen Monat.

UPDATE "OrgasmusBelohnungGutschrift"
SET "periodKey" = substr("periodKey", 1, 5) || printf('%02d', CAST(substr("periodKey", 6, 2) AS INTEGER) + 1) || substr("periodKey", 8)
WHERE "periodType" = 'day';

UPDATE "OrgasmusBelohnungGutschrift"
SET "periodKey" = substr("periodKey", 1, 7) || printf('%02d', CAST(substr("periodKey", 8, 2) AS INTEGER) + 1) || substr("periodKey", 10)
WHERE "periodType" = 'week';

UPDATE "OrgasmusBelohnungGutschrift"
SET "periodKey" = substr("periodKey", 1, 5) || printf('%02d', CAST(substr("periodKey", 6, 2) AS INTEGER) + 1)
WHERE "periodType" = 'month';
