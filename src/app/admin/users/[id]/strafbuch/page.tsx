import { auth } from "@/lib/auth";
import { assertKeyholderOrAdmin } from "@/lib/authGuards";
import { logAccess } from "@/lib/serverLog";
import { prisma } from "@/lib/prisma";
import { toDateLocale, formatDateTimeDual, formatDate, APP_TZ } from "@/lib/utils";
import { type StrafbuchControlOffense } from "@/lib/strafbuch";
import { requestNowMs, strafbuchCached } from "@/lib/dashboardData";
import { cleaningNotRelockedRef, OFFENSE_SEVERITY, SEVERITY_PENALTY_SUGGESTIONS, computeSeverities, type OffenseCanonicalType, type OffenseSeverity } from "@/lib/strafurteilService";
import { missedWeightRef } from "@/lib/weightObligation";
import { loadStatementsOfUser } from "@/lib/offenseStatementService";
import { passwordChangeViaLabel } from "@/lib/constants";
import type { CleaningBlockReason } from "@/lib/queries";
import { getLocale, getTranslations } from "next-intl/server";
import { boxPhotoMissingRef } from "@/lib/boxPhotoDue";
import StrafbuchClient, { type KontrollRow, type UnerlaubteOeffnungRow, type StrafeRecordData, type CleaningLimitRow, type AufgabeRow, type NichtVerschlossenRow, type VerschlussVersaeumtRow, type OrgasmusVersaeumtRow, type OrgasmusFalscheArtRow, type FalschesGeraetRow, type AdminPasswortRow, type UnerlaubterOrgasmusRow, type ManuellesVergehenRow, type MissedWeightRow, type BoxPhotoMissingRow, type StatementView, type SessionVersaeumtRow, type ErektionRow, type PauseUeberzugRow, type OrgasmusUeberBudgetRow, type SeverityInfo, type SeverityMatrixRow } from "./StrafbuchClient";

/** Warum eine als Reinigung erfasste Öffnung trotzdem im Strafbuch steht. */
const CLEANING_BLOCK_STRAFBUCH_KEY = {
  userNotAllowed: "strafbuchCleaningNotAllowed",
  lockPeriodForbids: "strafbuchCleaningLockPeriodForbids",
  outsideWindow: "strafbuchCleaningOutsideWindow",
} as const satisfies Record<CleaningBlockReason, string>;

export default async function StrafbuchPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  const { id } = await params;
  await assertKeyholderOrAdmin(id);
  const [t, tCommon, tOpen, dl] = [await getTranslations("admin"), await getTranslations("common"), await getTranslations("openForm"), toDateLocale(await getLocale())];
  // Die Anfrage-Uhr, nicht `new Date()`: das Layout zählt die offenen Vergehen für den Reiter aus
  // demselben Strafbuch (`strafbuchCached`), und die Ableitung läuft nur einmal, wenn beide denselben
  // Zeitpunkt nennen.
  const nowMs = requestNowMs();

  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) return <div className="p-8 text-foreground-faint">{t("userNotFound")}</div>;
  const tz = user.timezone;
  // Betrachter-Zeitzone (Keyholder): Zeiten primär in dieser tz, Sub-Lokalzeit als Zusatz bei Abweichung.
  const viewerTz = session?.user?.timezone ?? APP_TZ;
  const subLabel = t("subTimePrefix");
  const fmtDual = (d: Date) => formatDateTimeDual(d, dl, viewerTz, tz, subLabel);

  logAccess(session?.user.name ?? "?", `/admin/users/${user.username}/strafbuch`);

  // ALLE Stellungnahmen dieses Trägers, nicht die zu einer Auswahl von refIds: die Seite zeigt sein
  // ganzes Strafbuch, und die gefragte Menge wäre damit ohnehin die volle. Eine Stellungnahme
  // entsteht nur dort, wo er etwas geschrieben hat — die Tabelle bleibt klein.
  //
  // NEBEN der Ableitung, nicht dahinter: sie hängt an nichts, was `buildStrafbuch` liefert, und
  // hinter dem teuersten Aufruf der Seite eingereiht kostete sie eine eigene Runde zur Datenbank.
  const [sb, statementRows, sessionCategories] = await Promise.all([
    strafbuchCached(id, nowMs),
    loadStatementsOfUser(id),
    // Fork: Session-Kategorien (+ Geräte) für die Inline-Konfiguration der Pflicht-Session-Aktion.
    prisma.deviceCategory.findMany({
      where: { userId: id, isSessionCategory: true },
      orderBy: { sortOrder: "asc" },
      select: {
        id: true, name: true, maxSessionMinutes: true, requiresVideo: true,
        devices: { where: { archivedAt: null }, select: { id: true, name: true } },
      },
    }),
  ]);

  const cleaningLimitOffenses: CleaningLimitRow[] = sb.cleaningLimitViolations.map((v) => ({
    entryId: v.entryId,
    startTimeStr: v.startTime ? fmtDual(v.startTime) : "–",
    note: v.note,
  }));

  const missedWeightReports: MissedWeightRow[] = sb.missedWeightReports.map((m) => ({
    refId: missedWeightRef(m.dayKey),
    dayStr: fmtDual(m.at),
    days: m.days,
  }));

  const boxPhotoMissing: BoxPhotoMissingRow[] = sb.boxPhotoMissing.map((b) => ({
    refId: boxPhotoMissingRef(b.entryId),
    dueStr: fmtDual(b.dueAt),
    deadlineStr: fmtDual(b.at),
  }));

  const unerlaubteOeffnungen: UnerlaubteOeffnungRow[] = sb.unauthorizedOpenings.map((o) => ({
    id: o.id,
    startTimeStr: fmtDual(o.startTime),
    note: o.note,
    lockPeriodEndsAtStr: o.lockPeriodEndsAt ? fmtDual(o.lockPeriodEndsAt) : null,
    lockPeriodIndefinite: o.lockPeriodIndefinite,
    cleaningBlockStr: o.cleaningBlock ? t(CLEANING_BLOCK_STRAFBUCH_KEY[o.cleaningBlock]) : null,
  }));

  const toKontrollRow = (k: StrafbuchControlOffense, backdated: boolean): KontrollRow => ({
    id: k.id,
    code: k.code,
    deadlineStr: fmtDual(k.deadline),
    fulfilledAtStr: k.fulfilledAt ? fmtDual(k.fulfilledAt) : null,
    entryStartTimeStr: k.entryStartTime ? fmtDual(k.entryStartTime) : null,
    backdated,
    kommentar: k.kommentar,
    entryNote: k.entryNote,
  });
  const zuSpaet: KontrollRow[] = sb.lateControls.map((k) => toKontrollRow(k, k.backdated));
  const abgelehnt: KontrollRow[] = sb.rejectedControls.map((k) => toKontrollRow(k, false));
  const autoEntfernt: KontrollRow[] = sb.autoRemovedControls.map((k) => toKontrollRow(k, false));

  // Aufgaben-Vergehen: das Strafbuch leitet sie ab, der MCP kann sie beurteilen — nur diese Seite
  // zeigte sie nicht. Ein Vergehen, das der Keyholder in der Oberfläche nicht sieht, ist praktisch
  // keines.
  const aufgaben: AufgabeRow[] = sb.unfulfilledTasks.map((a) => ({
    id: a.id,
    title: a.title,
    holdUntilStr: fmtDual(a.holdUntil),
    state: a.state,
    failedAtStr: a.failedAt ? fmtDual(a.failedAt) : null,
    // Nur die TATSACHEN, aus denen der Vorwurf folgt — die Zeile zeigt weder den Beginn noch die
    // Bedingungen selbst an.
    started: a.startedAt !== null,
    hasRequirements: a.hasRequirements,
    isPenaltyTask: a.penaltyForRef !== null,
    penaltyReason: a.penaltyReason,
  }));

  // Die fünf folgenden Arten fehlten hier bis v5.0.3 — dieselbe Lücke wie bei den Aufgaben oben.
  const nichtVerschlossen: NichtVerschlossenRow[] = sb.cleaningNotRelocked.map((c) => ({
    // Präfix-ref, weil sich dieses Vergehen seinen Eintrag mit REINIGUNG_LIMIT teilt.
    refId: cleaningNotRelockedRef(c.entryId),
    startTimeStr: fmtDual(c.startTime),
    deadlineStr: fmtDual(c.deadline),
    relockAtStr: c.relockAt ? fmtDual(c.relockAt) : null,
    note: c.note,
  }));

  const verschlussVersaeumt: VerschlussVersaeumtRow[] = sb.lateLocks.map((a) => ({
    id: a.id,
    endsAtStr: fmtDual(a.endsAt),
    fulfilledAtStr: a.fulfilledAt ? fmtDual(a.fulfilledAt) : null,
    message: a.message,
    categoryName: a.categoryName,
  }));

  const orgasmusVersaeumt: OrgasmusVersaeumtRow[] = sb.missedOrgasmInstructions.map((m) => ({
    id: m.id,
    endsAtStr: fmtDual(m.endsAt),
    message: m.message,
    requiredType: m.requiredType,
  }));

  const orgasmusFalscheArt: OrgasmusFalscheArtRow[] = sb.wrongOrgasmTypes.map((m) => ({
    id: m.id,
    endsAtStr: fmtDual(m.endsAt),
    message: m.message,
    requiredType: m.requiredType,
    reportedType: m.reportedType,
  }));

  const falschesGeraet: FalschesGeraetRow[] = sb.wrongDeviceViolations.map((v) => ({
    entryId: v.entryId,
    startTimeStr: v.startTime ? fmtDual(v.startTime) : "–",
    deviceName: v.deviceName,
    note: v.note,
  }));

  const adminPasswort: AdminPasswortRow[] = sb.adminPasswordChanges.map((p) => ({
    id: p.id,
    atStr: fmtDual(p.at),
    adminUsername: p.adminUsername,
    viaLabel: passwordChangeViaLabel(p.via, t),
    lockPeriodEndsAtStr: p.lockPeriodEndsAt ? fmtDual(p.lockPeriodEndsAt) : null,
  }));

  const unerlaubteOrgasmen: UnerlaubterOrgasmusRow[] = sb.unauthorizedOrgasms.map((o) => ({
    id: o.id,
    startTimeStr: fmtDual(o.startTime),
    orgasmusArt: o.orgasmusArt,
    note: o.note,
    lockPeriodEndsAtStr: o.lockPeriodEndsAt ? fmtDual(o.lockPeriodEndsAt) : null,
    lockPeriodIndefinite: o.lockPeriodIndefinite,
  }));

  const manuelleVergehen: ManuellesVergehenRow[] = sb.manualOffenses.map((m) => ({
    id: m.id,
    occurredAtStr: fmtDual(m.occurredAt),
    title: m.title,
    description: m.description,
    createdBy: m.createdBy,
  }));

  // ── Fork-Arten ──
  const pauseGrundLabel = (grund: string | null): string | null =>
    grund === "REINIGUNG" ? tOpen("grundReinigung") : grund === "TOILETTE" ? tOpen("grundToilette") : null;
  const pauseDeviceLabel = (device: string | null): string =>
    device === "PLUG" ? t("kontrolleDevicePlug") : device === "CAGE" ? t("kontrolleDeviceCage") : "–";

  const sessionVersaeumt: SessionVersaeumtRow[] = sb.missedSessions.map((m) => ({
    id: m.id,
    endetAtStr: fmtDual(m.endetAt),
    categoryName: m.categoryName,
    nachricht: m.nachricht,
  }));

  const erektionen: ErektionRow[] = sb.erektionViolations.map((v) => ({
    entryId: v.entryId,
    startTimeStr: v.startTime ? fmtDual(v.startTime) : "–",
    grundLabel: pauseGrundLabel(v.oeffnenGrund),
    note: v.note,
  }));

  const pauseUeberzug: PauseUeberzugRow[] = sb.pauseOverageViolations.map((v) => {
    const grund = pauseGrundLabel(v.grund);
    return {
      entryId: v.entryId,
      startTimeStr: v.startTime ? fmtDual(v.startTime) : "–",
      context: grund ? `${pauseDeviceLabel(v.device)} / ${grund}` : pauseDeviceLabel(v.device),
      dauerStr: t("strafbuchPauseUeberzugDauer", { dauer: v.dauerMin, max: v.maxMin }),
      note: v.note,
    };
  });

  const orgasmusUeberBudget: OrgasmusUeberBudgetRow[] = sb.orgasmOverBudgetViolations.map((v) => ({
    entryId: v.entryId,
    startTimeStr: fmtDual(v.startTime),
    orgasmusArt: v.orgasmusArt,
    used: v.used,
    limit: v.limit,
  }));

  // Fork: effektive Schwere je erkanntem Vergehen (inkl. Wiederholungs-Eskalation).
  const severities: Record<string, SeverityInfo> = Object.fromEntries(
    [...computeSeverities(sb, new Date(nowMs))].map(([refId, s]) => [refId, { severity: s.severity, escalated: s.escalated }]),
  );

  // Fork: Schwere-Übersicht (Legende) — je Stufe die zugehörigen Arten + Straf-Vorschläge. Die
  // Beschriftung je Art ist dieselbe wie die Sektions-Überschrift im Client.
  const typeLabelByCanonical: Record<OffenseCanonicalType, string> = {
    unauthorized_opening: t("strafbuchUnerlaubteOeffnungen"),
    late_control: t("strafbuchZuSpaet"),
    rejected_control: t("strafbuchAbgelehnt"),
    auto_removed_control: t("strafbuchAutoEntfernt"),
    cleaning_limit: t("strafbuchReinigungLimit"),
    wrong_device: t("strafbuchFalschesGeraet"),
    missed_orgasm: t("strafbuchOrgasmusVersaeumt"),
    wrong_orgasm_type: t("strafbuchOrgasmusFalscheArt"),
    late_lock: t("strafbuchVerschlussVersaeumt"),
    cleaning_not_relocked: t("strafbuchNichtVerschlossen"),
    unfulfilled_task: t("strafbuchAufgaben"),
    admin_password_change: t("strafbuchAdminPasswort"),
    unauthorized_orgasm: t("strafbuchUnerlaubterOrgasmus"),
    missed_weight_report: t("strafbuchGewichtVersaeumt"),
    box_photo_missing: t("strafbuchBoxFotoFehlt"),
    manual_offense: t("strafbuchManuelleVergehen"),
    missed_session: t("strafbuchVersaeumteSession"),
    erektion: t("strafbuchErektion"),
    pause_overage: t("strafbuchPauseUeberzug"),
    orgasm_over_budget: t("strafbuchOrgasmusUeberBudget"),
  };
  const matrix: SeverityMatrixRow[] = (["schwer", "mittel", "leicht"] as OffenseSeverity[]).map((severity) => ({
    severity,
    offenses: (Object.keys(OFFENSE_SEVERITY) as OffenseCanonicalType[])
      .filter((c) => OFFENSE_SEVERITY[c] === severity)
      .map((c) => typeLabelByCanonical[c]),
    suggestions: SEVERITY_PENALTY_SUGGESTIONS[severity].map((s) => s.label),
  }));

  // NEUESTE ZUERST: die Vorgeschichte im Urteils-Formular nimmt den ersten Treffer ihrer Art als
  // „zuletzt". Hier sortiert und nicht im Client, weil dort nur noch der formatierte Tag ankommt —
  // ein zweites Feld mit den Millisekunden bloss zum Sortieren wäre dieselbe Angabe zweimal.
  const strafeRecords: StrafeRecordData[] = [...sb.strafeRecords]
    .sort((a, b) => b.bestraftDatum.getTime() - a.bestraftDatum.getTime())
    .map((r) => ({
      refId: r.refId,
      offenseType: r.offenseType,
      status: r.status,
      // Fork-Altbestand: KI-Strafen aus dem Chat trugen ihren Text vor v4.8x nur in `notiz`.
      reason: r.reason ?? r.notiz,
      judgedBy: r.judgedBy,
      judgedByName: r.judgedByName,
      judgedAtStr: formatDate(r.bestraftDatum, dl, tz),
      done: r.erledigtAt !== null,
      erledigtAtStr: r.erledigtAt ? formatDate(r.erledigtAt, dl, tz) : null,
      reportedDoneAtStr: r.reportedDoneAt ? formatDate(r.reportedDoneAt, dl, tz) : null,
      // Fork-Extras zur Erledigt-Meldung.
      nachweisUrl: r.nachweisUrl,
      erledigungNotiz: r.erledigungNotiz,
      ablehnungGrund: r.ablehnungGrund,
    }));

  const statements: Record<string, StatementView> = Object.fromEntries(
    [...statementRows].map(([refId, r]) => [refId, {
      text: r.text,
      editedAtStr: r.editedAt ? formatDate(r.editedAt, dl, tz) : null,
    }]),
  );

  const labels = {
    networkError: tCommon("networkError"),
    frist: t("frist"),
    instructionLabel: t("instructionLabel"),
    strafbuchUnerlaubteOeffnungen: t("strafbuchUnerlaubteOeffnungen"),
    strafbuchZuSpaet: t("strafbuchZuSpaet"),
    strafbuchAbgelehnt: t("strafbuchAbgelehnt"),
    strafbuchAutoEntfernt: t("strafbuchAutoEntfernt"),
    strafbuchAutoEntferntAm: t("strafbuchAutoEntferntAm"),
    strafbuchNoEntries: t("strafbuchNoEntries"),
    recordOffense: t("recordOffense"),
    strafbuchUrteilLabel: t("strafbuchUrteilLabel"),
    strafbuchUrteilPlaceholder: t("strafbuchUrteilPlaceholder"),
    strafbuchUrteilAufgabe: t("strafbuchUrteilAufgabe"),
    strafbuchStrafeBeschreiben: t("strafbuchStrafeBeschreiben"),
    strafbuchGemeldet: t("strafbuchGemeldet", { date: "{date}" }),
    strafbuchAlleAnzeigen: t("strafbuchAlleAnzeigen"),
    strafbuchOffeneAnzeigen: t("strafbuchOffeneAnzeigen"),
    strafbuchAbbrechen: t("strafbuchAbbrechen"),
    strafbuchRueckgaengig: t("strafbuchRueckgaengig"),
    strafbuchRueckgaengigConfirm: t("strafbuchRueckgaengigConfirm"),
    strafbuchFolgeStrafe: t("strafbuchFolgeStrafe"),
    strafbuchFolgeVerworfen: t("strafbuchFolgeVerworfen"),
    strafbuchStellungnahme: t("strafbuchStellungnahme"),
    strafbuchStellungnahmeGeaendert: t("strafbuchStellungnahmeGeaendert", { date: "{date}" }),
    // Der Platzhalter reist als sein eigener Wert durch — dasselbe Muster wie `strafbuchUrteilVon`
    // darunter: der Server kennt die Zahl nicht, und `t()` wirft, wenn eine Vorlage ihre Werte
    // vermisst. Eingesetzt wird im Client (`String.replace`).
    strafbuchFruehereStrafen: t("strafbuchFruehereStrafen", { count: "{count}" }),
    strafbuchZuletztVerhaengt: t("strafbuchZuletztVerhaengt", { date: "{date}", text: "{text}" }),
    strafbuchGeoeffnetAm: t("strafbuchGeoeffnetAm"),
    strafbuchTrotzUnbefristet: t("strafbuchTrotzUnbefristet"),
    strafbuchSperreLiefBis: t("strafbuchSperreLiefBis"),
    strafbuchKontrollePrefix: t("strafbuchKontrollePrefix"),
    strafbuchEingereicht: t("strafbuchEingereicht"),
    strafbuchVordatiert: t("strafbuchVordatiert"),
    strafbuchAbgelehntAm: t("strafbuchAbgelehntAm"),
    strafbuchAblehnungsgrund: t("strafbuchAblehnungsgrund"),
    strafbuchAlleVergehenBestraft: t("strafbuchAlleVergehenBestraft"),
    strafbuchOffen: t("strafbuchOffen"),
    strafbuchGesamt: t("strafbuchGesamt"),
    strafbuchReinigungLimit: t("strafbuchReinigungLimit"),
    strafbuchGewichtVersaeumt: t("strafbuchGewichtVersaeumt"),
    strafbuchGewichtVersaeumtTage: t("strafbuchGewichtVersaeumtTage"),
    strafbuchBoxFotoFehlt: t("strafbuchBoxFotoFehlt"),
    strafbuchBoxFotoFrist: t("strafbuchBoxFotoFrist"),
    strafbuchReinigungLimitDate: t("strafbuchReinigungLimitDate"),
    strafbuchVerwerfen: t("strafbuchVerwerfen"),
    strafbuchVergehenVerwerfen: t("strafbuchVergehenVerwerfen"),
    strafbuchVerworfenBadge: t("strafbuchVerworfenBadge"),
    strafbuchBegruendung: t("strafbuchBegruendung"),
    strafbuchUrteilKI: t("strafbuchUrteilKI"),
    // Als Vorlage, nicht als fertiger Satz: den Namen setzt der Client ein, er kennt die Zeile.
    strafbuchUrteilVon: t("strafbuchUrteilVon", { name: "{name}" }),
    strafbuchStrafeLabel: t("strafbuchStrafeLabel"),
    strafbuchStrafePlaceholder: t("strafbuchStrafePlaceholder"),
    strafbuchStrafeVerhaengen: t("strafbuchStrafeVerhaengen"),
    strafbuchStrafeBadge: t("strafbuchStrafeBadge"),
    strafbuchErledigtBadge: t("strafbuchErledigtBadge"),
    strafbuchAlsErledigt: t("strafbuchAlsErledigt"),
    strafbuchWiederOffen: t("strafbuchWiederOffen"),
    strafbuchAufgaben: t("strafbuchAufgaben"),
    strafbuchAufgabeVersaeumt: t("strafbuchAufgabeVersaeumt"),
    strafbuchAufgabeAbgebrochen: t("strafbuchAufgabeAbgebrochen"),
    strafbuchAufgabeAbgelegtAm: t("strafbuchAufgabeAbgelegtAm"),
    strafbuchAufgabeNachweisFehlt: t("strafbuchAufgabeNachweisFehlt"),
    strafbuchAufgabeNachweisFristAm: t("strafbuchAufgabeNachweisFristAm"),
    strafbuchAufgabeNichtErfuellt: t("strafbuchAufgabeNichtErfuellt"),
    strafbuchStrafaufgabeKette: t("strafbuchStrafaufgabeKette"),
    strafbuchNichtVerschlossen: t("strafbuchNichtVerschlossen"),
    strafbuchNichtVerschlossenNie: t("strafbuchNichtVerschlossenNie"),
    strafbuchWiederVerschlossen: t("strafbuchWiederVerschlossen"),
    strafbuchVerschlussFrist: t("strafbuchVerschlussFrist"),
    strafbuchVerschlussVersaeumt: t("strafbuchVerschlussVersaeumt"),
    strafbuchVerschlussNieErfuellt: t("strafbuchVerschlussNieErfuellt"),
    strafbuchVerschlussZuSpaet: t("strafbuchVerschlussZuSpaet"),
    strafbuchOrgasmusVersaeumt: t("strafbuchOrgasmusVersaeumt"),
    strafbuchOrgasmusAbgelaufen: t("strafbuchOrgasmusAbgelaufen"),
    strafbuchOrgasmusVorgegeben: t("strafbuchOrgasmusVorgegeben"),
    strafbuchOrgasmusFalscheArt: t("strafbuchOrgasmusFalscheArt"),
    strafbuchOrgasmusGemeldet: t("strafbuchOrgasmusGemeldet"),
    strafbuchFalschesGeraet: t("strafbuchFalschesGeraet"),
    strafbuchFalschesGeraetAm: t("strafbuchFalschesGeraetAm"),
    strafbuchAdminPasswort: t("strafbuchAdminPasswort"),
    strafbuchAdminPasswortAm: t("strafbuchAdminPasswortAm"),
    strafbuchAdminPasswortKonto: t("strafbuchAdminPasswortKonto"),
    strafbuchUnerlaubterOrgasmus: t("strafbuchUnerlaubterOrgasmus"),
    strafbuchOrgasmusAm: t("strafbuchOrgasmusAm"),
    strafbuchOhneDirektive: t("strafbuchOhneDirektive"),
    strafbuchManuelleVergehen: t("strafbuchManuelleVergehen"),
    strafbuchNotiertVon: t("strafbuchNotiertVon"),
    strafbuchZurueckziehen: t("strafbuchZurueckziehen"),
    deviceLabel: t("deviceLabel"),
    // ── Fork ──
    strafbuchUrteilSchicksalsrad: t("strafbuchUrteilSchicksalsrad"),
    strafbuchKeyholderStrafe: t("strafbuchKeyholderStrafe"),
    strafbuchKeyholderStrafeHint: t("strafbuchKeyholderStrafeHint"),
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
    strafbuchAktionStundenFehlt: t("strafbuchAktionStundenFehlt"),
    strafbuchAktionFehlgeschlagen: t("strafbuchAktionFehlgeschlagen"),
    strafbuchStrafeOderAktion: t("strafbuchStrafeOderAktion"),
    strafbuchVersaeumteSession: t("strafbuchVersaeumteSession"),
    strafbuchErektion: t("strafbuchErektion"),
    strafbuchErektionDate: t("strafbuchErektionDate"),
    strafbuchPauseUeberzug: t("strafbuchPauseUeberzug"),
    strafbuchOrgasmusUeberBudget: t("strafbuchOrgasmusUeberBudget"),
    strafbuchSessionKategorieOption: t("strafbuchSessionKategorieOption", { name: "{name}", max: "{max}" }),
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
  };

  return (
    <StrafbuchClient
      userId={id}
      unerlaubteOeffnungen={unerlaubteOeffnungen}
      zuSpaet={zuSpaet}
      abgelehnt={abgelehnt}
      autoEntfernt={autoEntfernt}
      cleaningLimitOffenses={cleaningLimitOffenses}
      missedWeightReports={missedWeightReports}
      boxPhotoMissing={boxPhotoMissing}
      unfulfilledTasks={aufgaben}
      nichtVerschlossen={nichtVerschlossen}
      verschlussVersaeumt={verschlussVersaeumt}
      orgasmusVersaeumt={orgasmusVersaeumt}
      orgasmusFalscheArt={orgasmusFalscheArt}
      falschesGeraet={falschesGeraet}
      adminPasswort={adminPasswort}
      unerlaubteOrgasmen={unerlaubteOrgasmen}
      manuelleVergehen={manuelleVergehen}
      sessionVersaeumt={sessionVersaeumt}
      erektionen={erektionen}
      pauseUeberzug={pauseUeberzug}
      orgasmusUeberBudget={orgasmusUeberBudget}
      strafeRecords={strafeRecords}
      statements={statements}
      labels={labels}
      severities={severities}
      suggestions={SEVERITY_PENALTY_SUGGESTIONS}
      matrix={matrix}
      sessionCategories={sessionCategories}
      verdienteOrgasmen={user.verdienteOrgasmen}
    />
  );
}
