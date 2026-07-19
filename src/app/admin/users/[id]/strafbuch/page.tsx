import { auth } from "@/lib/auth";
import { assertKeyholderOrAdmin } from "@/lib/authGuards";
import { logAccess } from "@/lib/serverLog";
import { prisma } from "@/lib/prisma";
import { toDateLocale, formatDateTimeDual, formatDate, APP_TZ } from "@/lib/utils";
import { buildStrafbuch } from "@/lib/strafbuch";
import { OFFENSE_SEVERITY, SEVERITY_RANK, SEVERITY_PENALTY_SUGGESTIONS, computeSeverities, type OffenseSeverity, type OffenseCanonicalType } from "@/lib/strafurteilService";
import { getLocale, getTranslations } from "next-intl/server";
import StrafbuchClient, { type OffenseRow, type StrafeRecordData } from "./StrafbuchClient";

export default async function StrafbuchPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  const { id } = await params;
  await assertKeyholderOrAdmin(id);
  const [t, dl] = [await getTranslations("admin"), toDateLocale(await getLocale())];
  const now = new Date();

  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) return <div className="p-8 text-foreground-faint">{t("userNotFound")}</div>;
  const tz = user.timezone;
  const viewerTz = session?.user?.timezone ?? APP_TZ;
  const subLabel = t("subTimePrefix");
  const fmtDual = (d: Date) => formatDateTimeDual(d, dl, viewerTz, tz, subLabel);

  logAccess(session?.user.name ?? "?", `/admin/users/${user.username}/strafbuch`);

  const sb = await buildStrafbuch(id, now);

  // Session-Kategorien (+ Geräte) für die vollständige Inline-Konfiguration der Pflicht-Session-Aktion.
  const sessionCategoriesRaw = await prisma.deviceCategory.findMany({
    where: { userId: id, isSessionCategory: true },
    orderBy: { sortOrder: "asc" },
    select: {
      id: true, name: true, maxSessionMinutes: true, requiresVideo: true,
      devices: { where: { archivedAt: null }, select: { id: true, name: true } },
    },
  });

  // ── Vereinheitlichtes Vergehens-Ledger — alle Typen in EINER Liste (chronologisch) ──
  const offenses: (OffenseRow & { sortAt: number })[] = [];

  for (const o of sb.unauthorizedOpenings) {
    const qualifier = o.sperrzeitIndefinite
      ? t("strafbuchTrotzUnbefristet")
      : o.sperrzeitEndetAt ? `${t("strafbuchSperreLiefBis")} ${fmtDual(o.sperrzeitEndetAt)}` : null;
    offenses.push({
      refId: o.id, offenseType: "OEFFNEN_ENTRY", severity: OFFENSE_SEVERITY["unauthorized_opening"], typeLabel: t("strafbuchUnerlaubteOeffnungen"),
      headline: `${t("strafbuchGeoeffnetAm")} ${fmtDual(o.startTime)}${qualifier ? ` — ${qualifier}` : ""}`,
      detail: null, note: o.note, sortAt: o.startTime.getTime(),
    });
  }
  for (const k of sb.lateControls) {
    offenses.push({
      refId: k.id, offenseType: "KONTROLLANFORDERUNG", severity: OFFENSE_SEVERITY["late_control"], typeLabel: t("strafbuchZuSpaet"),
      headline: `${t("strafbuchKontrollePrefix")} ${k.code} — ${t("strafbuchEingereicht")} ${k.fulfilledAt ? fmtDual(k.fulfilledAt) : "?"}${k.backdated && k.entryStartTime ? ` (${t("strafbuchVordatiert")} ${fmtDual(k.entryStartTime)})` : ""}`,
      detail: `${t("strafbuchFristWar")} ${fmtDual(k.deadline)}`, note: k.kommentar,
      sortAt: (k.fulfilledAt ?? k.deadline).getTime(),
    });
  }
  for (const k of sb.rejectedControls) {
    offenses.push({
      refId: k.id, offenseType: "KONTROLLANFORDERUNG", severity: OFFENSE_SEVERITY["rejected_control"], typeLabel: t("strafbuchAbgelehnt"),
      headline: `${t("strafbuchKontrollePrefix")} ${k.code} — ${t("strafbuchAbgelehntAm")} ${fmtDual(k.entryStartTime ?? k.deadline)}`,
      detail: `${t("strafbuchFristWar")} ${fmtDual(k.deadline)}`, note: k.entryNote ?? k.kommentar,
      sortAt: (k.entryStartTime ?? k.deadline).getTime(),
    });
  }
  for (const m of sb.missedLockRequests) {
    offenses.push({
      refId: m.id, offenseType: "VERSCHLUSS_ANFORDERUNG", severity: OFFENSE_SEVERITY["missed_lock"], typeLabel: t("strafbuchVerpassteVerschluss"),
      headline: `${t("strafbuchVerpassteVerschluss")}${m.categoryName ? ` (${m.categoryName})` : ""} — ${t("strafbuchFristWar")} ${fmtDual(m.endetAt)}`,
      detail: null, note: m.nachricht, sortAt: m.endetAt.getTime(),
    });
  }
  for (const v of sb.wrongDeviceViolations) {
    offenses.push({
      refId: v.entryId, offenseType: "FALSCHES_GERAET", severity: OFFENSE_SEVERITY["wrong_device"], typeLabel: t("strafbuchFalschesGeraet"),
      headline: `${t("strafbuchFalschesGeraet")} (${v.deviceName ?? "?"})${v.startTime ? ` — ${fmtDual(v.startTime)}` : ""}`,
      detail: null, note: v.note, sortAt: v.startTime?.getTime() ?? 0,
    });
  }
  for (const m of sb.missedOrgasmInstructions) {
    offenses.push({
      refId: m.id, offenseType: "ORGASMUS_ANWEISUNG", severity: OFFENSE_SEVERITY["missed_orgasm"], typeLabel: t("strafbuchVerpassteOrgasmus"),
      headline: `${t("strafbuchVerpassteOrgasmus")} — ${t("strafbuchFristWar")} ${fmtDual(m.endetAt)}`,
      detail: m.requiredArt, note: m.nachricht, sortAt: m.endetAt.getTime(),
    });
  }
  for (const m of sb.missedSessions) {
    offenses.push({
      refId: m.id, offenseType: "SESSION_VERSAEUMT", severity: OFFENSE_SEVERITY["missed_session"], typeLabel: t("strafbuchVersaeumteSession"),
      headline: `${t("strafbuchVersaeumteSession")}${m.categoryName ? ` (${m.categoryName})` : ""} — ${t("strafbuchFristWar")} ${fmtDual(m.endetAt)}`,
      detail: null, note: m.nachricht, sortAt: m.endetAt.getTime(),
    });
  }
  for (const v of sb.erektionViolations) {
    offenses.push({
      refId: v.entryId, offenseType: "EREKTION", severity: OFFENSE_SEVERITY["erektion"], typeLabel: t("strafbuchErektion"),
      headline: `${t("strafbuchErektionDate")} ${v.startTime ? fmtDual(v.startTime) : "–"}`,
      detail: v.oeffnenGrund, note: v.note, sortAt: v.startTime?.getTime() ?? 0,
    });
  }
  for (const v of sb.pauseOverageViolations) {
    const geraet = v.device === "PLUG" ? "Plug" : v.device === "CAGE" ? "Käfig" : "?";
    offenses.push({
      refId: v.entryId, offenseType: "PAUSE_OVERAGE", severity: OFFENSE_SEVERITY["pause_overage"], typeLabel: t("strafbuchPauseUeberzug"),
      headline: `${t("strafbuchPauseUeberzug")} (${geraet}${v.grund ? `/${v.grund}` : ""}) — ${v.dauerMin} Min statt max. ${v.maxMin} Min${v.startTime ? `, ${fmtDual(v.startTime)}` : ""}`,
      detail: null, note: v.note, sortAt: v.startTime?.getTime() ?? 0,
    });
  }
  for (const k of sb.autoRemovedControls) {
    offenses.push({
      refId: k.id, offenseType: "AUTO_ENTFERNT", severity: OFFENSE_SEVERITY["auto_removed_control"], typeLabel: t("strafbuchAutoEntfernt"),
      headline: `${t("strafbuchKontrollePrefix")} ${k.code} — ${t("strafbuchAutoEntferntAm")} ${fmtDual(k.deadline)}`,
      detail: t("strafbuchAutoEntferntDetail"), note: k.kommentar ?? k.entryNote, sortAt: k.deadline.getTime(),
    });
  }
  // Effektive Schwere (Phase 2: Wiederholungs-Eskalation) je Vergehen anwenden.
  const sevMap = computeSeverities(sb, now);
  for (const o of offenses) {
    const s = sevMap.get(o.refId);
    if (s) { o.severity = s.severity; o.escalated = s.escalated; }
  }

  // ── Direkt verhängte Strafen ohne Vergehen (Keyholderin/KI im Chat, offenseType AI_KEYHOLDER) ──
  // Diese Records hängen an keinem erkannten Vergehen. Ohne eigene Zeile wären sie im Strafbuch
  // unsichtbar — die Keyholderin könnte eine gemeldete Erledigung nie prüfen (der Sub sieht sie aber).
  const offenseRefIds = new Set(offenses.map((o) => o.refId));
  for (const r of sb.strafeRecords) {
    if (offenseRefIds.has(r.refId)) continue;
    offenses.push({
      refId: r.refId,
      offenseType: "AI_KEYHOLDER",
      severity: null,
      standalone: true,
      typeLabel: t("strafbuchKeyholderStrafe"),
      headline: r.reason ?? r.notiz ?? t("strafbuchKeyholderStrafe"),
      detail: t("strafbuchKeyholderStrafeHint"),
      note: null,
      sortAt: r.bestraftDatum.getTime(),
    });
  }

  // Sortierung: direkt verhängte Strafen zuerst (verlangen ggf. eine Prüfung), dann schwere
  // Vergehen vor leichten; innerhalb einer Stufe neueste zuerst.
  const rank = (o: OffenseRow) => (o.severity ? SEVERITY_RANK[o.severity] : -1);
  offenses.sort((a, b) => rank(a) - rank(b) || b.sortAt - a.sortAt);

  const strafeRecords: StrafeRecordData[] = sb.strafeRecords.map((r) => ({
    refId: r.refId,
    status: r.status,
    bestraftDatumStr: formatDate(r.bestraftDatum, dl, tz),
    notiz: r.notiz,
    reason: r.reason,
    judgedBy: r.judgedBy,
    done: r.erledigtAt !== null,
    erledigtAtStr: r.erledigtAt ? formatDate(r.erledigtAt, dl, tz) : null,
    gemeldetAtStr: r.gemeldetAt ? formatDate(r.gemeldetAt, dl, tz) : null,
    nachweisUrl: r.nachweisUrl,
    erledigungNotiz: r.erledigungNotiz,
    ablehnungGrund: r.ablehnungGrund,
  }));

  const labels = {
    strafbuchVergehen: t("strafbuchVergehen"),
    strafbuchNoEntries: t("strafbuchNoEntries"),
    strafbuchAlleVergehenBestraft: t("strafbuchAlleVergehenBestraft"),
    strafbuchWurdeBestraft: t("strafbuchWurdeBestraft"),
    strafbuchAbbrechen: t("strafbuchAbbrechen"),
    strafbuchRueckgaengig: t("strafbuchRueckgaengig"),
    strafbuchAlleAnzeigen: t("strafbuchAlleAnzeigen"),
    strafbuchOffeneAnzeigen: t("strafbuchOffeneAnzeigen"),
    strafbuchOffen: t("strafbuchOffen"),
    strafbuchGesamt: t("strafbuchGesamt"),
    strafbuchVerwerfen: t("strafbuchVerwerfen"),
    strafbuchVerworfenBadge: t("strafbuchVerworfenBadge"),
    strafbuchBegruendung: t("strafbuchBegruendung"),
    strafbuchUrteilKI: t("strafbuchUrteilKI"),
    strafbuchStrafeLabel: t("strafbuchStrafeLabel"),
    strafbuchStrafePlaceholder: t("strafbuchStrafePlaceholder"),
    strafbuchStrafeVerhaengen: t("strafbuchStrafeVerhaengen"),
    strafbuchStrafeBadge: t("strafbuchStrafeBadge"),
    strafbuchErledigtBadge: t("strafbuchErledigtBadge"),
    strafbuchAlsErledigt: t("strafbuchAlsErledigt"),
    strafbuchWiederOffen: t("strafbuchWiederOffen"),
    strafbuchKeyholderStrafe: t("strafbuchKeyholderStrafe"),
    strafbuchGemeldetBadge: t("strafbuchGemeldetBadge"),
    strafbuchNachweis: t("strafbuchNachweis"),
    strafbuchBestaetigen: t("strafbuchBestaetigen"),
    strafbuchAblehnen: t("strafbuchAblehnen"),
    strafbuchAblehnenPlaceholder: t("strafbuchAblehnenPlaceholder"),
    strafbuchAbgelehntBadge: t("strafbuchAbgelehntBadge"),
    strafbuchVorschlaege: t("strafbuchVorschlaege"),
    schwereSchwer: t("strafbuchSchwereSchwer"),
    schwereMittel: t("strafbuchSchwereMittel"),
    schwereLeicht: t("strafbuchSchwereLeicht"),
    strafbuchLegende: t("strafbuchLegende"),
    strafbuchLegendeHint: t("strafbuchLegendeHint"),
    strafbuchHochgestuft: t("strafbuchHochgestuft"),
    strafbuchAktion: t("strafbuchAktion"),
    strafbuchAktionNone: t("strafbuchAktionNone"),
    strafbuchAktionStunden: t("strafbuchAktionStunden"),
    strafbuchAktionStundenFehlt: t("strafbuchAktionStundenFehlt"),
    strafbuchAktionFehlgeschlagen: t("strafbuchAktionFehlgeschlagen"),
    strafbuchStrafeOderAktion: t("strafbuchStrafeOderAktion"),
    aktSessionKategorie: t("sessionAnforderungCategory"),
    aktSessionMin: t("sessionAnforderungMinLabel"),
    aktSessionDelay: t("sessionAnforderungDelayLabel"),
    aktSessionGeraet: t("sessionAnforderungDeviceLabel"),
    aktSessionGeraetAny: t("sessionAnforderungDeviceAny"),
    aktSessionVideo: t("sessionAnforderungRequireVideo"),
    aktOrgasmusOeffnen: t("orgasmReqOpenAllowedLabel"),
    aktSperreReinigung: t("reinigungErlaubtLabel"),
    aktSperreToilette: t("toiletteErlaubtLabel"),
    aktPlugDauer: t("strafbuchAktPlugDauer"),
    aktPlugFrist: t("strafbuchAktPlugFrist"),
    aktKontrolleGeraet: t("kontrolleDeviceLabel"),
    aktKontrolleGeraetAllg: t("strafbuchAktKontrolleGeraetAllg"),
    aktKontrolleGeraetCage: t("kontrolleDeviceCage"),
    aktKontrolleGeraetPlug: t("kontrolleDevicePlug"),
    aktKontrolleFrist: t("strafbuchAktKontrolleFrist"),
    aktKontrolleCode: t("kontrolleRequireCode"),
    aktEntzugKeinGuthaben: t("belohnungEntzugKeinGuthaben"),
    strafbuchAktionLabels: {
      extend_lock: t("strafbuchAktExtendLock"),
      ruined_orgasm: t("strafbuchAktRuinedOrgasm"),
      mandatory_session: t("strafbuchAktMandatorySession"),
      bigger_plug: t("strafbuchAktBiggerPlug"),
      extra_control: t("strafbuchAktExtraControl"),
    },
  };

  // Schwere-Übersicht (Legende): je Stufe die zugehörigen Vergehen + Straf-Vorschläge.
  const typeLabelByCanonical: Record<OffenseCanonicalType, string> = {
    unauthorized_opening: t("strafbuchUnerlaubteOeffnungen"),
    late_control: t("strafbuchZuSpaet"),
    rejected_control: t("strafbuchAbgelehnt"),
    auto_removed_control: t("strafbuchAutoEntfernt"),
    wrong_device: t("strafbuchFalschesGeraet"),
    missed_lock: t("strafbuchVerpassteVerschluss"),
    missed_session: t("strafbuchVersaeumteSession"),
    missed_orgasm: t("strafbuchVerpassteOrgasmus"),
    pause_overage: t("strafbuchPauseUeberzug"),
    erektion: t("strafbuchErektion"),
  };
  const severityMatrix = (["schwer", "mittel", "leicht"] as OffenseSeverity[]).map((sev) => ({
    severity: sev,
    offenses: (Object.keys(OFFENSE_SEVERITY) as OffenseCanonicalType[])
      .filter((c) => OFFENSE_SEVERITY[c] === sev)
      .map((c) => typeLabelByCanonical[c]),
    suggestions: SEVERITY_PENALTY_SUGGESTIONS[sev].map((s) => s.label),
  }));

  return (
    <StrafbuchClient
      userId={id}
      offenses={offenses}
      strafeRecords={strafeRecords}
      labels={labels}
      suggestions={SEVERITY_PENALTY_SUGGESTIONS}
      matrix={severityMatrix}
      sessionCategories={sessionCategoriesRaw}
      verdienteOrgasmen={user.verdienteOrgasmen}
    />
  );
}
