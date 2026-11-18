"use client";

import { createContext, useContext } from "react";

/** Whether the AI keyholder is enabled for the viewing sub. Provided only under the
 *  dashboard layout — admin/keyholder views live outside it and read the default `false`,
 *  so the „Der Keyholderin zeigen"-Button never appears on someone else's entries. */
const KeyholderEnabledContext = createContext(false);

export function KeyholderEnabledProvider({
  enabled,
  children,
}: {
  enabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <KeyholderEnabledContext.Provider value={enabled}>
      {children}
    </KeyholderEnabledContext.Provider>
  );
}

export function useKeyholderEnabled(): boolean {
  return useContext(KeyholderEnabledContext);
}
