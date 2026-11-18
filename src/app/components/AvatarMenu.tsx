"use client";

import { useEffect, useRef, useState } from "react";
import BlockHeading from "@/app/components/BlockHeading";
import Link from "next/link";
import { Settings, LogOut, ScrollText, Nfc, Bot } from "lucide-react";
import { useTranslations } from "next-intl";
import { useSignOut } from "@/app/hooks/useSignOut";
import { LockClosedIcon } from "@/app/components/lockIcons";

interface Props {
  username: string;
  settingsHref: string;
  theme: "user" | "admin";
  version?: string;
  /** Globale Admins sehen die instanzweiten KI-Backend- und Airlock-Einstellungen. (Die
   *  Benutzerverwaltung ist seit v6.2.4 ein Symbol-Knopf in `AdminHeader`, siehe unten.) */
  isGlobalAdmin?: boolean;
  /** Show the "Meine Airlock-Schlösser" entry — nur wenn dem User Locks zugewiesen sind (Sub-Bereich). */
  showMyAirlock?: boolean;
}

// Die Benutzerverwaltung stand hier einmal als eigener Eintrag, gehalten von `isGlobalAdmin`. Sie
// hängt seit v6.2.4 als Symbol-Knopf in `AdminHeader` — und weil `Header.tsx` (grüner Kopf)
// `isGlobalAdmin` nie durchreichte, erschien der Eintrag ohnehin AUSSCHLIESSLICH in derselben
// Kopfzeile, gut vierzig Pixel neben dem neuen Knopf. Zwei Türen in einer Leiste sind keine bessere
// Auffindbarkeit, sondern zweimal dasselbe. `isGlobalAdmin` bleibt für die selteneren
// Instanz-Einstellungen (KI-Backend, Airlock), die keinen eigenen Knopf in der Kopfzeile haben.
export default function AvatarMenu({ username, settingsHref, theme, version, isGlobalAdmin, showMyAirlock }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const t = useTranslations("nav");
  const { requestSignOut, signOutDialog } = useSignOut();

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  const initial = username?.[0]?.toUpperCase() ?? "?";

  const avatarBg = "bg-header-avatar-bg text-header-avatar-text";
  const menuBg = "bg-surface border border-border shadow-overlay";
  const itemBase = "flex items-center gap-3 px-4 py-3 text-sm font-medium transition-colors w-full text-left";
  const itemNormal = `${itemBase} text-foreground-muted hover:text-foreground hover:bg-surface-raised`;
  const itemDanger = `${itemBase} text-warn hover:bg-warn-bg`;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`w-8 h-8 rounded-full text-xs font-bold flex items-center justify-center flex-shrink-0 transition-opacity hover:opacity-80 ${avatarBg}`}
        aria-label={t("menu")}
      >
        {initial}
      </button>

      {open && (
        <>
          <div
            className="sm:hidden fixed inset-0 z-40"
            onClick={() => setOpen(false)}
          />
          <div className={`absolute right-0 top-10 z-50 w-52 rounded-2xl overflow-hidden ${menuBg}`}>
            <BlockHeading as="span" className="block px-4 py-3 border-b border-border">
              {username}
            </BlockHeading>
            <Link href={settingsHref} onClick={() => setOpen(false)} className={itemNormal}>
              <Settings size={16} strokeWidth={1.75} />
              {t("settings")}
            </Link>
            {isGlobalAdmin && (
              <Link href="/admin/ai-backend" onClick={() => setOpen(false)} className={itemNormal}>
                <Bot size={16} strokeWidth={1.75} />
                {t("aiBackend")}
              </Link>
            )}
            {isGlobalAdmin && (
              <Link href="/admin/airlock" onClick={() => setOpen(false)} className={itemNormal}>
                <Nfc size={16} strokeWidth={1.75} />
                {t("airlock")}
              </Link>
            )}
            {theme === "user" && showMyAirlock && (
              <Link href="/dashboard/airlock" onClick={() => setOpen(false)} className={itemNormal}>
                <Nfc size={16} strokeWidth={1.75} />
                {t("myAirlock")}
              </Link>
            )}
            {theme === "user" && (
              <>
                <Link href="/dashboard/geraete" onClick={() => setOpen(false)} className={itemNormal}>
                  <LockClosedIcon size={16} strokeWidth={1.75} />
                  {t("devices")}
                </Link>
                <Link href="/dashboard/regeln" onClick={() => setOpen(false)} className={itemNormal}>
                  <ScrollText size={16} strokeWidth={1.75} />
                  {t("rules")}
                </Link>
              </>
            )}
            <div className="border-t border-border-subtle" />
            <button
              onClick={() => { setOpen(false); requestSignOut(); }}
              className={itemDanger}
            >
              <LogOut size={16} strokeWidth={1.75} />
              {t("signOut")}
            </button>
          </div>
        </>
      )}
      {signOutDialog}
    </div>
  );
}
