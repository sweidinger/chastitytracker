/*
  Warnings:

  - You are about to drop the column `referenceSex` on the `User` table. All the data in the column will be lost.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'user',
    "email" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reinigungErlaubt" BOOLEAN NOT NULL DEFAULT false,
    "reinigungMaxMinuten" INTEGER NOT NULL DEFAULT 15,
    "reinigungMaxProTag" INTEGER NOT NULL DEFAULT 0,
    "reinigungsFenster" TEXT,
    "autoKontrolleAktiv" BOOLEAN NOT NULL DEFAULT false,
    "autoKontrollePerDayMin" INTEGER NOT NULL DEFAULT 0,
    "autoKontrollePerDayMax" INTEGER NOT NULL DEFAULT 0,
    "autoKontrolleRuheVon" TEXT NOT NULL DEFAULT '22:00',
    "autoKontrolleRuheBis" TEXT NOT NULL DEFAULT '06:00',
    "autoKontrolleFristVon" INTEGER NOT NULL DEFAULT 15,
    "autoKontrolleFristBis" INTEGER NOT NULL DEFAULT 60,
    "autoKontrolleFensterVon" TEXT NOT NULL DEFAULT '',
    "autoKontrolleFensterBis" TEXT NOT NULL DEFAULT '',
    "autoKontrolleNurBeiSperre" BOOLEAN NOT NULL DEFAULT false,
    "autoInspectionPlannedFor" DATETIME,
    "inspectionReminderEnabled" BOOLEAN NOT NULL DEFAULT false,
    "inspectionReminderDelayMinutes" INTEGER NOT NULL DEFAULT 5,
    "inspectionAutoMarkEnabled" BOOLEAN NOT NULL DEFAULT false,
    "inspectionAutoMarkDelayMinutes" INTEGER NOT NULL DEFAULT 60,
    "mobileDesktopUpload" BOOLEAN NOT NULL DEFAULT false,
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Zurich',
    "startPage" TEXT NOT NULL DEFAULT 'auto',
    "hideOwnTracker" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT NOT NULL DEFAULT 'de',
    "orgasmusArtenConfig" TEXT,
    "oeffnenGruendeConfig" TEXT,
    "dashboardLayout" TEXT,
    "mcpKeyholderInstructions" TEXT,
    "weightTrackingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "heightCm" INTEGER,
    "unitSystem" TEXT NOT NULL DEFAULT 'metric',
    "targetMinKg" REAL,
    "targetMaxKg" REAL,
    "targetMinKeyholderKg" REAL,
    "targetMaxKeyholderKg" REAL,
    "weighingWindows" TEXT,
    -- Fork-Spalten (sweidinger): beim Tabellen-Neuaufbau mitnehmen, sonst gehen sie verloren
    "toiletteErlaubt" BOOLEAN NOT NULL DEFAULT false,
    "toiletteMaxMinuten" INTEGER NOT NULL DEFAULT 15,
    "toiletteMaxProTag" INTEGER NOT NULL DEFAULT 0,
    "plugReinigungErlaubt" BOOLEAN NOT NULL DEFAULT false,
    "plugReinigungMaxMinuten" INTEGER NOT NULL DEFAULT 15,
    "plugReinigungMaxProTag" INTEGER NOT NULL DEFAULT 0,
    "plugReinigungsFenster" TEXT,
    "plugToiletteMaxMinuten" INTEGER NOT NULL DEFAULT 15,
    "orgasmBudget" INTEGER,
    "orgasmBudgetPeriode" TEXT NOT NULL DEFAULT 'WOCHE',
    "orgasmBudgetSetAt" DATETIME,
    "verdienteOrgasmen" INTEGER NOT NULL DEFAULT 0,
    "denialRecordDays" INTEGER NOT NULL DEFAULT 0
);
INSERT INTO "new_User" ("autoInspectionPlannedFor", "autoKontrolleAktiv", "autoKontrolleFensterBis", "autoKontrolleFensterVon", "autoKontrolleFristBis", "autoKontrolleFristVon", "autoKontrolleNurBeiSperre", "autoKontrollePerDayMax", "autoKontrollePerDayMin", "autoKontrolleRuheBis", "autoKontrolleRuheVon", "createdAt", "dashboardLayout", "email", "heightCm", "hideOwnTracker", "id", "inspectionAutoMarkDelayMinutes", "inspectionAutoMarkEnabled", "inspectionReminderDelayMinutes", "inspectionReminderEnabled", "locale", "mcpKeyholderInstructions", "mobileDesktopUpload", "oeffnenGruendeConfig", "orgasmusArtenConfig", "passwordHash", "reinigungErlaubt", "reinigungMaxMinuten", "reinigungMaxProTag", "reinigungsFenster", "role", "startPage", "targetMaxKeyholderKg", "targetMaxKg", "targetMinKeyholderKg", "targetMinKg", "timezone", "unitSystem", "username", "weighingWindows", "weightTrackingEnabled", "toiletteErlaubt", "toiletteMaxMinuten", "toiletteMaxProTag", "plugReinigungErlaubt", "plugReinigungMaxMinuten", "plugReinigungMaxProTag", "plugReinigungsFenster", "plugToiletteMaxMinuten", "orgasmBudget", "orgasmBudgetPeriode", "orgasmBudgetSetAt", "verdienteOrgasmen", "denialRecordDays") SELECT "autoInspectionPlannedFor", "autoKontrolleAktiv", "autoKontrolleFensterBis", "autoKontrolleFensterVon", "autoKontrolleFristBis", "autoKontrolleFristVon", "autoKontrolleNurBeiSperre", "autoKontrollePerDayMax", "autoKontrollePerDayMin", "autoKontrolleRuheBis", "autoKontrolleRuheVon", "createdAt", "dashboardLayout", "email", "heightCm", "hideOwnTracker", "id", "inspectionAutoMarkDelayMinutes", "inspectionAutoMarkEnabled", "inspectionReminderDelayMinutes", "inspectionReminderEnabled", "locale", "mcpKeyholderInstructions", "mobileDesktopUpload", "oeffnenGruendeConfig", "orgasmusArtenConfig", "passwordHash", "reinigungErlaubt", "reinigungMaxMinuten", "reinigungMaxProTag", "reinigungsFenster", "role", "startPage", "targetMaxKeyholderKg", "targetMaxKg", "targetMinKeyholderKg", "targetMinKg", "timezone", "unitSystem", "username", "weighingWindows", "weightTrackingEnabled", "toiletteErlaubt", "toiletteMaxMinuten", "toiletteMaxProTag", "plugReinigungErlaubt", "plugReinigungMaxMinuten", "plugReinigungMaxProTag", "plugReinigungsFenster", "plugToiletteMaxMinuten", "orgasmBudget", "orgasmBudgetPeriode", "orgasmBudgetSetAt", "verdienteOrgasmen", "denialRecordDays" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
