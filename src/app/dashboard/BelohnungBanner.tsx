"use client";

import { Gift } from "lucide-react";
import TimerDisplay from "@/app/components/TimerDisplay";

export interface BelohnungBannerLabels {
  title: string;
  available: string;
  reserved: string;
  windowLabel: string;
  oeffnenAllowed: string;
}

interface Props {
  available: number;
  reserved: number;
  activeWindowEndetAt: string | null;
  oeffnenErlaubt: boolean;
  labels: BelohnungBannerLabels;
}

/** Sub-Dashboard: Belohnungs-Guthaben ganz oben (immer sichtbar, analog zum Admin-Panel). */
export default function BelohnungBanner({ available, reserved, activeWindowEndetAt, oeffnenErlaubt, labels }: Props) {
  return (
    <div className="w-full max-w-2xl mx-auto px-4 pt-4">
      <div className="rounded-2xl border border-[var(--color-ok)] bg-[color-mix(in_srgb,var(--color-ok)_8%,transparent)] px-5 py-4">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 bg-[color-mix(in_srgb,var(--color-ok)_15%,transparent)] text-[var(--color-ok)]">
            <Gift size={24} strokeWidth={2} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold uppercase tracking-widest text-[var(--color-ok)] opacity-80">{labels.title}</p>
            <p className="text-sm text-foreground">
              {labels.available}: <span className="font-bold">{available}</span>
              {reserved > 0 && <> · {labels.reserved}: <span className="font-bold">{reserved}</span></>}
            </p>
            {activeWindowEndetAt && (
              <div className="mt-1 text-xs text-foreground-muted flex items-center gap-2">
                <span>{labels.windowLabel}</span>
                <TimerDisplay targetDate={new Date(activeWindowEndetAt)} mode="countdown" format="short" className="font-semibold text-foreground" />
                {oeffnenErlaubt && <span className="text-[var(--color-ok)]">· {labels.oeffnenAllowed}</span>}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
