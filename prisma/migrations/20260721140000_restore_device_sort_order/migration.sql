-- Fork-Rettung, Teil 2 von 2 (Gegenstueck: 20260717225900_backup_device_sort_order).
--
-- Legt die von upstreams Rebuild (20260717230000_pull_off_risk_nullable) entfernte Fork-Spalte
-- "Device"."sortOrder" wieder an und schreibt die zuvor gesicherten Werte zurueck, sodass die
-- Groessen-Reihenfolge je Kategorie den Upstream-Merge unbeschadet uebersteht.

ALTER TABLE "Device" ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;

UPDATE "Device"
SET "sortOrder" = (
    SELECT b."sortOrder" FROM "_fork_device_sort_order" b WHERE b."id" = "Device"."id"
)
WHERE "id" IN (SELECT "id" FROM "_fork_device_sort_order");

DROP TABLE "_fork_device_sort_order";
