-- Fork-Rettung, Teil 1 von 2 (Gegenstueck: 20260721140000_restore_device_sort_order).
--
-- Upstreams naechste Migration 20260717230000_pull_off_risk_nullable baut "Device" per
-- SQLite-Rebuild-Pattern neu auf (CREATE new_Device / INSERT SELECT / DROP Device). Das
-- INSERT SELECT listet nur die Spalten aus UPSTREAMS Schema -- die Fork-Spalte "sortOrder"
-- faellt dabei ersatzlos heraus.
--
-- Anders als bei 20260713110000_restore_fork_columns reicht ein blosses Wiederanlegen hier
-- NICHT: "sortOrder" traegt die Groessen-Reihenfolge innerhalb einer Kategorie und steuert
-- die Auswahl des naechstgroesseren Geraets (Strafe). Auf Default 0 zurueckgesetzt waere die
-- Reihenfolge verloren und die Strafenlogik wuerde willkuerliche Geraete waehlen.
--
-- Deshalb: Werte hier sichern, nach dem Rebuild zurueckschreiben.
-- Diese Migration laeuft absichtlich unmittelbar VOR dem Rebuild (Zeitstempel 22:59 vs. 23:00).
-- Auf einer Neuinstallation ist das unkritisch: 20260709030000_device_sort_order legt die
-- Spalte lange vorher an, die Tabelle ist dann nur leer.

CREATE TABLE "_fork_device_sort_order" (
    "id"        TEXT    NOT NULL PRIMARY KEY,
    "sortOrder" INTEGER NOT NULL DEFAULT 0
);

INSERT INTO "_fork_device_sort_order" ("id", "sortOrder")
SELECT "id", "sortOrder" FROM "Device";
