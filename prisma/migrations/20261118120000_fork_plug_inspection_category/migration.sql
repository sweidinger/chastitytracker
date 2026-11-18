-- Fork-Merge: Plug-Kontrollen des Forks trugen ihr Ziel nur in der Spalte "device" ('PLUG') und
-- hatten keine categoryId. Upstream liest das Ziel einer Kontrolle aus categoryId (null = KG) —
-- ohne diese Nachführung erschienen alte Plug-Kontrollen als KG-Kontrollen (Strafbuch, Listen,
-- Erfüllung über WEAR statt VERSCHLUSS).
--
-- Zugeordnet wird die eingebaute Plug-Kategorie DESSELBEN Users, per Slug ermittelt (nicht über eine
-- angenommene id). Users ohne Plug-Kategorie bleiben unverändert. Idempotent: nur Zeilen mit
-- categoryId IS NULL werden angefasst.
UPDATE "KontrollAnforderung"
SET "categoryId" = (
  SELECT dc."id" FROM "DeviceCategory" dc
  WHERE dc."userId" = "KontrollAnforderung"."userId" AND dc."slug" = 'plug'
  LIMIT 1
)
WHERE "device" = 'PLUG'
  AND "categoryId" IS NULL
  AND EXISTS (
    SELECT 1 FROM "DeviceCategory" dc
    WHERE dc."userId" = "KontrollAnforderung"."userId" AND dc."slug" = 'plug'
  );
