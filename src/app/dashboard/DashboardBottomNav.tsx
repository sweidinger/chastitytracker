"use client";

import { useState } from "react";
import BottomNav from "@/app/components/BottomNav";
import NewEntrySheet, { type NewEntryCategoryRow } from "@/app/components/NewEntrySheet";

interface Props {
  isAdmin?: boolean;
  isKeyholder?: boolean;
  isLocked: boolean;
  version?: string;
  categoryRows?: NewEntryCategoryRow[];
  bildersafe?: boolean;
  aiKeyholderEnabled?: boolean;
}

export default function DashboardBottomNav({ isAdmin, isKeyholder, isLocked, version, categoryRows, bildersafe, aiKeyholderEnabled }: Props) {
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
        categoryRows={categoryRows}
        bildersafe={bildersafe}
      />
    </>
  );
}
