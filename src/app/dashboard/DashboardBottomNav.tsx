"use client";

import { useState } from "react";
import BottomNav from "@/app/components/BottomNav";
import NewEntrySheet, { type NewEntryCategoryRow } from "@/app/components/NewEntrySheet";
import type { BildersafeMenuAction } from "@/lib/queries";

interface Props {
  isAdmin?: boolean;
  isKeyholder?: boolean;
  isLocked: boolean;
  lockCallPending?: boolean;
  version?: string;
  categoryRows?: NewEntryCategoryRow[];
  /** Welche Bildersafe-Zeile das (+)-Menü zeigt (`bildersafeMenuAction`); null = keine. */
  bildersafe?: BildersafeMenuAction | null;
  weight?: boolean;
  /** Die dringendste offene Kontroll-Anforderung — Begründung in `NewEntrySheet`. */
  openInspection?: { code: string | null; href: string } | null;
  /** Fork: KI-Keyholderin-Eintrag in der Navigation zeigen. */
  aiKeyholderEnabled?: boolean;
}

export default function DashboardBottomNav({ isAdmin, isKeyholder, isLocked, lockCallPending, version, categoryRows, bildersafe, weight, openInspection, aiKeyholderEnabled }: Props) {
  const [sheetOpen, setSheetOpen] = useState(false);

  return (
    <>
      <BottomNav
        isAdmin={isAdmin}
        isKeyholder={isKeyholder}
        isLocked={isLocked}
        onNewEntry={() => setSheetOpen(true)}
        version={version}
        aiKeyholderEnabled={aiKeyholderEnabled}
      />
      <NewEntrySheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        isLocked={isLocked}
        lockCallPending={lockCallPending}
        categoryRows={categoryRows}
        bildersafe={bildersafe}
        weight={weight}
        openInspection={openInspection}
      />
    </>
  );
}
