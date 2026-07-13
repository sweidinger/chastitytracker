"use client";

import Link from "next/link";
import { Lock } from "lucide-react";
import { useTranslations } from "next-intl";
import EmptyState from "@/app/components/EmptyState";
import KontrolleBanner from "@/app/components/KontrolleBanner";
import LockRequestBanner from "@/app/components/LockRequestBanner";
import { formatHoursHM } from "@/lib/utils";
import { useLiveHours } from "@/app/hooks/useLiveHours";

// ── Types ────────────────────────────────────
export interface DashboardProps {
  currentStatus: { type: "VERSCHLUSS" | "OEFFNEN"; since: string } | null;
  hasEntries: boolean;

  // Kontrolle — je Gerät (CAGE/PLUG) kann eine aktiv sein
  offeneKontrollen: {
    deadline: string;
    code: string | null;
    kommentar: string | null;
    overdue: boolean;
    href: string;
    device: "CAGE" | "PLUG";
  }[];

  // Verschluss-Anforderung
  offeneVerschlussAnf: {
    endetAt: string | null;
    nachricht: string | null;
    overdue: boolean;
    endetAtLabel: string | null;
    deviceName: string | null;
  } | null;

  // Sperrzeit
  activeSperrzeit: {
    endetAt: string | null;
    nachricht: string | null;
    endetAtLabel: string | null;
  } | null;

  // Plug-Anforderung (Tragen anfordern)
  offenePlugAnf: {
    endetAt: string | null;
    nachricht: string | null;
    endetAtLabel: string | null;
    categoryId: string;
    overdue: boolean;
  } | null;

  // Plug-Sperrdauer
  activePlugSperrzeit: {
    endetAt: string | null;
    nachricht: string | null;
    endetAtLabel: string | null;
  } | null;

  // Orgasmus-Anforderung
  offeneOrgasmusAnf: {
    label: string;
    nachricht: string | null;
    windowLabel: string;
    overdue: boolean;
  } | null;

  // Offene Session-Anforderungen (Admin/AI-Keyholderin) — je Kategorie ein Banner mit Start-Button.
  sessionAnforderungen: {
    categoryId: string;
    categoryName: string;
    nachricht: string | null;
    endetAtLabel: string | null;
    overdue: boolean;
  }[];

  // Stats
  tagH: number;
  wocheH: number;
  monatH: number;
  serverNow: string;
  elapsedTagH: number;
  elapsedWocheH: number;
  elapsedMonatH: number;

  /** Governing timezone of the data owner (sub). Defaults to APP_TZ (Europe/Zurich). */
  tz?: string;
}

// ── Helpers ──────────────────────────────────

function WearPercent({ wornH, elapsedH }: { wornH: number; elapsedH: number }) {
  if (elapsedH <= 0) return null;
  const pct = Math.min(100, Math.round((wornH / elapsedH) * 100));
  return (
    <div className="mt-2">
      <div className="h-1.5 rounded-full bg-border overflow-hidden">
        <div className="h-full rounded-full bg-lock" style={{ width: `${pct}%` }} />
      </div>
      <p className="text-[10px] text-foreground-faint mt-0.5 tabular-nums">{pct}%</p>
    </div>
  );
}

// ── Component ────────────────────────────────
export default function DashboardClient(props: DashboardProps) {
  const t = useTranslations("dashboard");
  const tCommon = useTranslations("common");
  const {
    currentStatus,
    hasEntries,
    offeneKontrollen,
    offeneVerschlussAnf,
    activeSperrzeit,
    offenePlugAnf,
    activePlugSperrzeit,
    offeneOrgasmusAnf,
    sessionAnforderungen,
    tagH: baseTagH,
    wocheH: baseWocheH,
    monatH: baseMonatH,
    serverNow,
    elapsedTagH: baseElapsedTagH,
    elapsedWocheH: baseElapsedWocheH,
    elapsedMonatH: baseElapsedMonatH,
    tz,
  } = props;

  const isLocked = currentStatus?.type === "VERSCHLUSS";

  const tagH = useLiveHours(baseTagH, serverNow, isLocked);
  const wocheH = useLiveHours(baseWocheH, serverNow, isLocked);
  const monatH = useLiveHours(baseMonatH, serverNow, isLocked);
  const elapsedTagH = useLiveHours(baseElapsedTagH, serverNow, true);
  const elapsedWocheH = useLiveHours(baseElapsedWocheH, serverNow, true);
  const elapsedMonatH = useLiveHours(baseElapsedMonatH, serverNow, true);

  // Lock-Request-Banner — auch im Empty-State sichtbar, sonst sehen frische User
  // mit einer offenen Anforderung nichts und reagieren nur auf die Mail.
  const lockRequestBanner = offeneVerschlussAnf ? (
    <LockRequestBanner
      variant="large"
      colorScheme="request"
      label={t("lockRequested")}
      nachricht={[offeneVerschlussAnf.deviceName ? t("lockDevicePrefix", { name: offeneVerschlussAnf.deviceName }) : null, offeneVerschlussAnf.nachricht].filter(Boolean).join(" · ") || null}
      endetAtLabel={offeneVerschlussAnf.endetAtLabel}
      overdue={offeneVerschlussAnf.overdue}
      action={{ label: t("lockRequestAction"), href: "/dashboard/new/verschluss" }}
    />
  ) : null;

  const orgasmusRequestBanner = offeneOrgasmusAnf ? (
    <LockRequestBanner
      variant="large"
      colorScheme="orgasm"
      label={offeneOrgasmusAnf.label}
      nachricht={offeneOrgasmusAnf.nachricht}
      endetAtLabel={offeneOrgasmusAnf.windowLabel}
      overdue={offeneOrgasmusAnf.overdue}
      action={{ label: t("orgasmRequestAction"), href: "/dashboard/new/orgasmus" }}
    />
  ) : null;

  const plugAnforderungBanner = offenePlugAnf ? (
    <LockRequestBanner
      variant="large"
      colorScheme="request"
      label={t("plugWearRequest")}
      nachricht={offenePlugAnf.nachricht}
      endetAtLabel={offenePlugAnf.endetAtLabel}
      overdue={offenePlugAnf.overdue}
      action={{ label: t("plugWearRequestAction"), href: `/dashboard/new/wear-begin?category=${offenePlugAnf.categoryId}` }}
    />
  ) : null;

  const sessionAnforderungBanners = sessionAnforderungen.map((s) => (
    <LockRequestBanner
      key={s.categoryId}
      variant="large"
      colorScheme="request"
      label={t("sessionRequest", { name: s.categoryName })}
      nachricht={s.nachricht}
      endetAtLabel={s.endetAtLabel}
      overdue={s.overdue}
      action={{ label: t("sessionRequestAction"), href: `/dashboard/new/session-begin?category=${s.categoryId}` }}
    />
  ));

  const plugSperrzeitBanner = activePlugSperrzeit ? (
    <LockRequestBanner
      variant="large"
      colorScheme="sperrzeit"
      label={t("plugWearDuration")}
      nachricht={activePlugSperrzeit.nachricht}
      endetAtLabel={activePlugSperrzeit.endetAtLabel}
    />
  ) : null;

  if (!hasEntries) {
    return (
      <main className="flex-1 w-full max-w-2xl mx-auto px-4 py-8 flex flex-col gap-5">
        {lockRequestBanner}
        {orgasmusRequestBanner}
        {plugAnforderungBanner}
        {sessionAnforderungBanners}
        {plugSperrzeitBanner}
        <EmptyState
          icon={<Lock size={48} />}
          title={t("welcomeTitle")}
          description={t("welcomeDesc")}
          action={{ label: t("welcomeCta"), href: "/dashboard/new/verschluss" }}
        />
      </main>
    );
  }

  return (
    <main className="flex-1 w-full max-w-2xl mx-auto px-4 py-6 flex flex-col gap-5">

      {/* Status-Hero (offener Zustand) wird jetzt oben in page.tsx gerendert. */}

      {/* ── Alert Banners ── */}
      {offeneKontrollen.map((k) => (
        <KontrolleBanner
          key={k.device}
          deadline={new Date(k.deadline)}
          code={k.code}
          kommentar={k.kommentar}
          overdue={k.overdue}
          variant="large"
          href={k.href}
          openLabel={t("inspectionRequired")}
          deviceLabel={t(k.device === "PLUG" ? "deviceLabelPlug" : "deviceLabelCage")}
          tz={tz}
        />
      ))}

      {lockRequestBanner}

      {orgasmusRequestBanner}

      {plugAnforderungBanner}

      {sessionAnforderungBanners}

      {plugSperrzeitBanner}

      {/* Sperrzeit-Banner entfernt — wird bereits im Sperrzeit-Footer der LaufendeSessionCard angezeigt */}

      {/* ── Stats Summary ── */}
      <div className="rounded-xl border border-border bg-surface p-4 sm:p-5">
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-foreground-faint">
            {t("statsTitle")}
          </p>
          <Link href="/dashboard/stats" className="text-xs text-foreground-faint hover:text-foreground-muted transition">
            {t("allStats")} →
          </Link>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-xl bg-surface-raised px-3 py-3">
            <p className="text-xl font-bold text-lock tabular-nums">{formatHoursHM(tagH)}</p>
            <p className="text-xs text-foreground-faint mt-0.5">{t("wearToday")}</p>
            <WearPercent wornH={tagH} elapsedH={elapsedTagH} />
          </div>
          <div className="rounded-xl bg-surface-raised px-3 py-3">
            <p className="text-xl font-bold text-lock tabular-nums">{formatHoursHM(wocheH)}</p>
            <p className="text-xs text-foreground-faint mt-0.5">{t("wearWeek")}</p>
            <WearPercent wornH={wocheH} elapsedH={elapsedWocheH} />
          </div>
          <div className="rounded-xl bg-surface-raised px-3 py-3">
            <p className="text-xl font-bold text-lock tabular-nums">{formatHoursHM(monatH)}</p>
            <p className="text-xs text-foreground-faint mt-0.5">{t("wearMonth")}</p>
            <WearPercent wornH={monatH} elapsedH={elapsedMonatH} />
          </div>
        </div>
      </div>

      {/* Actions accessible via Neu-Button in bottom nav */}

    </main>
  );
}

