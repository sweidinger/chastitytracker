import { prisma } from "@/lib/prisma";
import { mapAnforderungStatus, tzDateParts, isPastDeadlineUnfulfilled, dateAtLocalMinutes, APP_TZ } from "@/lib/utils";
import { activeVerschlussAnforderungWhere, cleaningBlockReason, type CleaningPermissionUser } from "@/lib/queries";
import { aktivesReinigungsFenster } from "@/lib/reinigungService";
import { hhmmToMinutes } from "@/lib/autoKontrolleService";
import { pauseReasonsForDevice, pauseSettingsForDevice, type PauseDevice } from "@/lib/pauseService";

/** A Kontroll-based offense (late or rejected) — raw data, formatting left to consumers. */
export interface StrafbuchControlOffense {
  id: string;
  code: string;
  deadline: Date;
  fulfilledAt: Date | null;
  entryStartTime: Date | null;
  /** True if the entry was backdated before the deadline but submitted after it. */
  backdated: boolean;
  kommentar: string | null;
  entryNote: string | null;
}

/** Raw Strafbuch data for a user — system-detected offenses + the punished-marker records.
 *  Pure data (Date objects); display formatting is the consumer's job. */
export interface StrafbuchData {
  unauthorizedOpenings: {
    id: string;
    startTime: Date;
    note: string | null;
    sperrzeitEndetAt: Date | null;
    sperrzeitIndefinite: boolean;
  }[];
  lateControls: StrafbuchControlOffense[];
  rejectedControls: StrafbuchControlOffense[];
  /** Kontrollen, deren Eskalations-Mahnung ignoriert wurde — System hat automatisch als abgelegt
   *  markiert (siehe inspectionEscalationService.ts). Nie zusammen mit lateControls/rejectedControls
   *  für dieselbe Zeile, da autoMarkedRemovedAt niemals mit gesetztem entryId koexistiert. */
  autoRemovedControls: StrafbuchControlOffense[];
  /** Lock entries where the user wore a different device than the Anforderung specified. */
  /** REINIGUNG-Oeffnungen ueber dem Tageskontingent — Erkennung, keine automatische Strafe. */
  reinigungLimitViolations: {
    entryId: string;
    startTime: Date | null;
    note: string | null;
  }[];
  wrongDeviceViolations: {
    entryId: string;
    startTime: Date | null;
    note: string | null;
    deviceName: string | null;
  }[];
  /** Mandatory orgasm directives (ANWEISUNG) whose window ended without a matching orgasm. */
  missedOrgasmInstructions: {
    id: string;
    endetAt: Date;
    nachricht: string | null;
    requiredArt: string | null;
    /** true = die Anweisung war selbst eine Strafe (strengere Eskalation bei Nicht-Erfüllung). */
    istStrafe: boolean;
  }[];
  /** Session-Anforderungen deren Frist ohne erfüllende Session ablief. */
  missedSessions: {
    id: string;
    endetAt: Date;
    nachricht: string | null;
    categoryName: string | null;
    /** true = die Session war selbst eine Strafe (strengere Eskalation bei Nicht-Erfüllung). */
    istStrafe: boolean;
  }[];
  /** Verschluss-Anforderungen (ANFORDERUNG) deren Frist zum Einschliessen unerfüllt ablief. */
  /** Pause-Enden (REINIGUNG/TOILETTE) where erektionGemeldet=true → nur erkannt (kein Auto-Urteil). */
  erektionViolations: {
    entryId: string;
    startTime: Date | null;
    oeffnenGrund: string | null;
    note: string | null;
  }[];
  /** Abgeschlossene Pausen (PAUSE_BEGIN→END), die die konfigurierte Maximaldauer überschritten. */
  pauseOverageViolations: {
    entryId: string;
    startTime: Date | null;
    device: string | null;
    grund: string | null;
    dauerMin: number;
    maxMin: number;
    note: string | null;
  }[];
  /** Verschluss-Anforderungen (lock requests) whose deadline (`endetAt`) passed without a timely VERSCHLUSS. */
  lateLocks: {
    id: string;
    endetAt: Date;
    fulfilledAt: Date | null;
    nachricht: string | null;
    /** Fork: Kaefig (null) vs. Plug/andere Kategorie — der Keyholder muss wissen, worum es ging. */
    categoryName: string | null;
  }[];
  /** REINIGUNG-Öffnungen during an active, cleaning-permitted Sperrzeit whose re-lock deadline
   *  (active daily cleaning window's end, or open time + reinigungMaxMinuten as fallback) passed
   *  without (or with a late) following VERSCHLUSS. */
  cleaningNotRelocked: {
    entryId: string;
    startTime: Date;
    deadline: Date;
    relockAt: Date | null;
    note: string | null;
  }[];
  /** Judgment records — each marks an offense (by `refId`) as PUNISHED or DISMISSED. */
  strafeRecords: {
    refId: string;
    offenseType: string;
    status: string; // "PUNISHED" | "DISMISSED"
    bestraftDatum: Date;
    notiz: string | null;
    reason: string | null;
    judgedBy: string | null;
    erledigtAt: Date | null;
    // Erledigungs-Meldung des Subs (offen → gemeldet → bestätigt/abgelehnt)
    gemeldetAt: Date | null;
    nachweisUrl: string | null;
    erledigungNotiz: string | null;
    ablehnungGrund: string | null;
  }[];
}

/** True if a Verschluss-Anforderung (lock request) deadline has passed without a timely
 *  VERSCHLUSS — still open past `endetAt`, or fulfilled after `endetAt`. */
export function isLateLock(a: { endetAt: Date; fulfilledAt: Date | null }, now: Date): boolean {
  return isPastDeadlineUnfulfilled(a.endetAt, a.fulfilledAt, now);
}

/** Re-lock deadline for a REINIGUNG-Öffnung: the end of the active daily cleaning window (`fenster`)
 *  if one was open at `openStartTime`, else open time + the user's max minutes per pause. A window
 *  configured but not covering `openStartTime` also falls back to `maxMinuten` — never silently
 *  skipped, since that case isn't otherwise detected as an offense. Windows never span midnight
 *  (`parseReinigungsFenster` requires start < end), so the window end is always the same calendar
 *  day as `openStartTime`. `dateAtLocalMinutes` resolves the window-end wall-clock time DST-safely
 *  (a flat millisecond offset from midnight would be wrong on the ~2 days/year a DST transition
 *  falls between midnight and the window end). */
export function reinigungRelockDeadline(openStartTime: Date, maxMinuten: number, fenster: unknown, tz: string): Date {
  const windowEnd = aktivesReinigungsFenster(fenster, openStartTime, tz);
  if (windowEnd) return dateAtLocalMinutes(openStartTime, hhmmToMinutes(windowEnd), tz);
  return new Date(openStartTime.getTime() + maxMinuten * 60 * 1000);
}

/** True if a REINIGUNG-Öffnung was not (or too late) followed by a VERSCHLUSS within `deadline`. */
export function isCleaningNotRelocked(deadline: Date, relockAt: Date | null, now: Date): boolean {
  return isPastDeadlineUnfulfilled(deadline, relockAt, now);
}

/** Finds the Sperrzeit active at `openTime` (if any) — shared by unauthorizedOpenings and
 *  cleaningNotRelocked, which both need to know whether an OEFFNEN fell inside an active lock period. */
function findActiveSperrzeit<S extends { createdAt: Date; endetAt: Date | null; withdrawnAt: Date | null }>(
  openTime: Date, sperrzeiten: S[],
): S | undefined {
  return sperrzeiten.find((s) =>
    openTime >= s.createdAt &&
    (s.endetAt === null || openTime < s.endetAt) &&
    (s.withdrawnAt === null || s.withdrawnAt > openTime),
  );
}

/** AppMeta-Schlüssel des Stichtags. Die Zeile schreibt die Migration
 *  `20260714210000_cleaning_window_enforced_from` beim ersten Boot dieser Instanz. */
const ENFORCED_FROM_KEY = "cleaningWindowEnforcedFrom";

/**
 * Ab wann gilt das Reinigungsfenster als Schranke? Bis zu diesem Zeitpunkt prüfte weder die
 * Durchsetzung noch das Strafbuch, ob eine Reinigungsöffnung in einem Fenster lag — sie war
 * schlicht erlaubt. Das Strafbuch ist eine LIVE-Ableitung aus den Einträgen: ohne Stichtag würden
 * mit dem Deploy rückwirkend Vergehen für Handlungen erscheinen, die zur Zeit der Tat erlaubt waren.
 * Niemand soll für eine Regel belangt werden, die es damals nicht gab.
 *
 * Der Stichtag ist ein Merkmal des DEPLOYS, nicht des CODES: dasselbe Image läuft auf 27 Instanzen,
 * die es zu verschiedenen Zeitpunkten bekommen. Deshalb steht er in der DB (`AppMeta`), geschrieben
 * von der Migration beim ERSTEN Boot dieser Instanz — dem einzigen Zeitpunkt, den keine Vorhersage
 * treffen muss. Ein einkompiliertes Datum stand zwangsläufig auf dem Tag EINER Instanz und hätte
 * allen anderen beim Rollout rückwirkend Vergehen für die Differenz beschert.
 *
 * `CLEANING_WINDOW_ENFORCED_FROM` (ISO-8601) übersteuert die Zeile — für bewusstes Rückdatieren
 * oder Korrigieren. Ohne beides (Zeile fehlt, Migration nie gelaufen) gilt der SICHERE Weg: `now`,
 * also ab jetzt — lieber ein Vergehen zu wenig als eines, das es damals nicht gab.
 */
export async function cleaningWindowEnforcedFrom(now: Date): Promise<Date> {
  const raw = process.env.CLEANING_WINDOW_ENFORCED_FROM;
  if (raw) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed;
    // Ein unlesbares Datum darf NICHT stillschweigend zu "gar kein Stichtag" werden — das bestrafte
    // rückwirkend die ganze Historie. Laut melden und die DB-Zeile nehmen.
    console.error(`[strafbuch] CLEANING_WINDOW_ENFORCED_FROM ist kein gültiges Datum: "${raw}" — nutze den Stichtag aus der DB`);
  }

  const row = await prisma.appMeta.findUnique({ where: { key: ENFORCED_FROM_KEY } });
  const stored = row ? new Date(row.value) : null;
  if (stored && !Number.isNaN(stored.getTime())) return stored;

  console.error(`[strafbuch] Kein Stichtag in AppMeta ("${ENFORCED_FROM_KEY}") — bewerte ab jetzt, keine rückwirkenden Vergehen`);
  return now;
}

/** True if a REINIGUNG opening inside `sperre` doesn't break the Sperrzeit. Delegates to
 *  {@link cleaningBlockReason} — the same rule the live enforcement applies — rather than restating
 *  it. Restating it is exactly how the cleaning WINDOW went missing here: an opening outside the
 *  window withdrew the Sperrzeit but was booked as neither an unauthorized opening nor anything
 *  else. The lock broke and nothing was recorded.
 *
 *  Evaluated at the opening's own `startTime`, not at `now`: the Strafbuch keeps a record of the
 *  past. (Live enforcement judges `now`, because that is when the bolt actually moves.) Öffnungen
 *  vor `enforcedFrom` (siehe {@link cleaningWindowEnforcedFrom}) werden ohne Fenster-Prüfung
 *  beurteilt.
 *
 *  Shared by unauthorizedOpenings (inverted: an opening that ISN'T allowed is unauthorized) and
 *  cleaningNotRelocked (only allowed openings can incur a missed-re-lock offense). */
function isAllowedReinigungOpening(
  o: { oeffnenGrund: string | null; startTime: Date },
  sperre: { reinigungErlaubt: boolean } | undefined,
  user: CleaningPermissionUser,
  enforcedFrom: Date,
): boolean {
  if (!sperre || o.oeffnenGrund !== "REINIGUNG") return false;
  const grandfathered = o.startTime < enforcedFrom;
  const effectiveUser = grandfathered ? { ...user, reinigungsFenster: null } : user;
  return cleaningBlockReason(effectiveUser, [sperre], o.startTime) === null;
}

/** Computes the Strafbuch for a user: unauthorized openings during Sperrzeiten, late and
 *  rejected Kontrollen, REINIGUNG-limit violations, late locks, missed cleaning re-locks, plus
 *  the punished-marker records. Single source of truth shared by the admin Strafbuch page and the MCP tool. */
export async function buildStrafbuch(userId: string, now: Date = new Date()): Promise<StrafbuchData> {
  // Der Stichtag haengt im selben Promise.all wie alles andere — einmal je Strafbuch, nicht je
  // Oeffnung, und ohne zusaetzlichen Roundtrip.
  const [enforcedFrom, user, oeffnungen, verschluesse, sperrzeiten, lockRequests, kontrollAnforderungen, strafeRecordsRaw, orgasmusAnforderungen, sessionAnforderungen, pauseEntries] = await Promise.all([
    cleaningWindowEnforcedFrom(now),
    prisma.user.findUnique({ where: { id: userId }, select: {
      reinigungErlaubt: true, reinigungMaxMinuten: true, reinigungMaxProTag: true, reinigungsFenster: true, timezone: true,
      toiletteErlaubt: true, toiletteMaxMinuten: true, toiletteMaxProTag: true,
      plugReinigungErlaubt: true, plugReinigungMaxMinuten: true, plugReinigungMaxProTag: true,
      plugToiletteMaxMinuten: true,
    } }),
    prisma.entry.findMany({ where: { userId, type: "OEFFNEN" }, orderBy: { startTime: "desc" } }),
    prisma.entry.findMany({ where: { userId, type: "VERSCHLUSS" }, orderBy: { startTime: "asc" } }),
    prisma.verschlussAnforderung.findMany({ where: { userId, art: "SPERRZEIT", ...activeVerschlussAnforderungWhere(now) } }),
    prisma.verschlussAnforderung.findMany({
      where: { userId, art: "ANFORDERUNG", withdrawnAt: null, ...activeVerschlussAnforderungWhere(now) },
      include: { deviceCategory: { select: { name: true } } },
    }),
    prisma.kontrollAnforderung.findMany({
      where: { userId, OR: [{ entryId: { not: null } }, { autoMarkedRemovedAt: { not: null } }] },
      include: { entry: true, autoMarkedEntry: true },
      orderBy: { createdAt: "desc" },
    }),
    prisma.strafeRecord.findMany({ where: { userId }, orderBy: { createdAt: "desc" } }),
    prisma.orgasmusAnforderung.findMany({ where: { userId } }),
    prisma.sessionAnforderung.findMany({
      where: { userId, fulfilledAt: null, withdrawnAt: null, endetAt: { lt: now }, OR: [{ wirksamAb: null }, { wirksamAb: { lte: now } }] },
      include: { deviceCategory: { select: { name: true } } },
    }),
    prisma.entry.findMany({
      where: { userId, type: { in: ["PAUSE_BEGIN", "PAUSE_END"] } },
      orderBy: { startTime: "asc" },
      select: { id: true, type: true, startTime: true, pauseDevice: true, oeffnenGrund: true, note: true, erektionGemeldet: true },
    }),
    // Versäumte Verschluss-Anforderungen: Frist (endetAt) abgelaufen, nicht erfüllt/zurückgezogen, bereits ausgelöst.
    prisma.verschlussAnforderung.findMany({
      where: { userId, art: "ANFORDERUNG", fulfilledAt: null, withdrawnAt: null, endetAt: { lt: now }, OR: [{ wirksamAb: null }, { wirksamAb: { lte: now } }] },
      include: { deviceCategory: { select: { name: true } } },
    }),
  ]);

  // Windows that explicitly permit opening to perform the directed orgasm — an OEFFNEN inside
  // such a window is not an unauthorized opening (like the REINIGUNG exception).
  const oeffnenErlaubtWindows = orgasmusAnforderungen.filter((a) => a.oeffnenErlaubt);
  const isOrgasmusOpenAllowed = (openTime: Date): boolean =>
    oeffnenErlaubtWindows.some((w) =>
      openTime >= w.beginntAt && openTime <= w.endetAt &&
      (w.withdrawnAt === null || w.withdrawnAt > openTime),
    );
  const userReinigungErlaubt = user?.reinigungErlaubt ?? false;
  const userToiletteErlaubt = user?.toiletteErlaubt ?? false;
  const reinigungMaxProTag = user?.reinigungMaxProTag ?? 0;
  const reinigungMaxMinuten = user?.reinigungMaxMinuten ?? 15;
  const reinigungsFenster = user?.reinigungsFenster ?? null;
  const subTz = user?.timezone ?? APP_TZ;
  /** Genau die Felder, die `cleaningBlockReason` prueft — einmal gebuendelt statt dreimal einzeln. */
  const cleaningUser: CleaningPermissionUser = {
    reinigungErlaubt: userReinigungErlaubt,
    reinigungsFenster,
    timezone: subTz,
  };

  // Erektion + Pause-Überzug: LIVE aus den Pausen abgeleitet (keine automatische Bestrafung mehr).
  // Erektion wird beim Pause-Ende gemeldet; Pause-Überzug = abgeschlossene Pause über der
  // konfigurierten Maximaldauer. Beides sind ERKENNUNGEN — Urteil durch Keyholderin (AI) oder Admin.
  // maxMin <= 0 gilt als unbegrenzt (keine Überzug-Erkennung).
  const erektionViolations: { entryId: string; startTime: Date | null; oeffnenGrund: string | null; note: string | null }[] = [];
  const pauseOverageViolations: StrafbuchData["pauseOverageViolations"] = [];
  if (user) {
    for (const device of ["CAGE", "PLUG"] as PauseDevice[]) {
      const devEntries = pauseEntries.filter((e) => e.pauseDevice === device);
      const reasons = pauseReasonsForDevice(user, device);
      const fallbackMax = pauseSettingsForDevice(user, device).maxMinuten;
      let openBegin: (typeof devEntries)[number] | null = null;
      for (const e of devEntries) {
        if (e.type === "PAUSE_BEGIN") {
          openBegin = e;
        } else if (e.type === "PAUSE_END" && openBegin) {
          const grund = openBegin.oeffnenGrund;
          // Erektion beim Pause-Ende gemeldet → Erkennung.
          if (e.erektionGemeldet)
            erektionViolations.push({ entryId: e.id, startTime: e.startTime, oeffnenGrund: grund ?? null, note: e.note });
          // Pause-Überzug: Dauer über der für den Grund konfigurierten Maximaldauer.
          const max = (grund ? reasons.find((r) => r.grund === grund)?.maxMinuten : undefined) ?? fallbackMax;
          if (max > 0) {
            const dauerMin = (e.startTime.getTime() - openBegin.startTime.getTime()) / 60000;
            if (dauerMin > max) {
              pauseOverageViolations.push({
                entryId: e.id, startTime: e.startTime, device, grund: grund ?? null,
                dauerMin: Math.round(dauerMin), maxMin: max, note: e.note,
              });
            }
          }
          openBegin = null;
        }
      }
    }
    erektionViolations.sort((a, b) => (b.startTime?.getTime() ?? 0) - (a.startTime?.getTime() ?? 0));
    pauseOverageViolations.sort((a, b) => (b.startTime?.getTime() ?? 0) - (a.startTime?.getTime() ?? 0));
  }

  // Falsches Geraet: LIVE aus den Eintraegen abgeleitet (Flag falschesGeraet) — keine automatische
  // Bestrafung mehr; ob geahndet wird, entscheidet die Keyholderin (AI) oder der Admin.
  const wrongDeviceEntries = await prisma.entry.findMany({
    where: { userId, type: "VERSCHLUSS", falschesGeraet: true },
    orderBy: { startTime: "desc" },
    include: { device: { select: { name: true } } },
  });
  const wrongDeviceViolations = wrongDeviceEntries.map((e) => ({
    entryId: e.id, startTime: e.startTime, note: e.note, deviceName: e.device?.name ?? null,
  }));

  // REINIGUNG-Oeffnung ueber dem Tageskontingent ist eine Erkennung; ob sie bestraft wird,
  // entscheidet die Keyholderin (punished = ein StrafeRecord referenziert den Eintrag).
  // 0 = unbegrenzt -> keine Verstoesse. Geraete-Wechsel laufen ueber diesen Pfad und werden
  // dadurch nicht mehr automatisch geahndet.
  const reinigungLimitViolations: { entryId: string; startTime: Date | null; note: string | null }[] = [];
  if (reinigungMaxProTag > 0) {
    const perDay = new Map<string, number>();
    const reinigungAsc = oeffnungen
      .filter((o) => o.oeffnenGrund === "REINIGUNG")
      .slice()
      .sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
    for (const o of reinigungAsc) {
      const { year, month, day } = tzDateParts(o.startTime);
      const key = `${year}-${month}-${day}`;
      const n = (perDay.get(key) ?? 0) + 1;
      perDay.set(key, n);
      if (n > reinigungMaxProTag) reinigungLimitViolations.push({ entryId: o.id, startTime: o.startTime, note: o.note });
    }
    reinigungLimitViolations.reverse(); // neueste zuerst (Anzeige)
  }

  // Each OEFFNEN paired with the Sperrzeit active at its startTime (if any) — computed once,
  // shared by unauthorizedOpenings and cleaningNotRelocked below.
  const oeffnungenMitSperre = oeffnungen.map((o) => ({ o, sperre: findActiveSperrzeit(o.startTime, sperrzeiten) }));

  // Unauthorized openings — an OEFFNEN inside an active Sperrzeit. A REINIGUNG opening is
  // permitted when both the user flag and the Sperrzeit allow cleaning. System-authored openings
  // (source="system", the inspection-escalation auto-mark) are EXCLUDED: that's the sub's
  // presumed removal already counted once as `autoRemovedControls` — it's not a willful action by
  // the sub, so flagging it a second time here would double-punish a single ambiguous event.
  const unauthorizedOpenings = oeffnungenMitSperre
    .filter(({ o, sperre }) => {
      if (o.source === "system" || !sperre) return false;
      if (isAllowedReinigungOpening(o, sperre, cleaningUser, enforcedFrom)) return false;
      // Fork: Toiletten-Oeffnung — dieselbe Ausnahme-Mechanik wie die Reinigung, nur ueber die
      // Toiletten-Freigabe von User UND Sperrzeit.
      if (o.oeffnenGrund === "TOILETTE" && userToiletteErlaubt && sperre.toiletteErlaubt) return false;
      if (isOrgasmusOpenAllowed(o.startTime)) return false;
      return true;
    })
    .map(({ o, sperre }) => ({
      id: o.id,
      startTime: o.startTime,
      note: o.note,
      sperrzeitEndetAt: sperre!.endetAt,
      sperrzeitIndefinite: sperre!.endetAt === null,
    }));

  // Late locks — an ANFORDERUNG (lock request) whose deadline passed without a timely VERSCHLUSS.
  const lateLocks = lockRequests
    .filter((a): a is typeof a & { endetAt: Date } => a.endetAt !== null)
    .filter((a) => isLateLock(a, now))
    .map((a) => ({ id: a.id, endetAt: a.endetAt, fulfilledAt: a.fulfilledAt, nachricht: a.nachricht, categoryName: a.deviceCategory?.name ?? null }));

  // Cleaning not relocked — a REINIGUNG opening during an active, cleaning-permitted Sperrzeit
  // whose re-lock deadline passed without a timely VERSCHLUSS. No offense if the Sperrzeit itself
  // already ended before the deadline: once the Sperrzeit is over there's no further re-lock
  // obligation left to violate, whether or not (or how late) the user eventually re-locks.
  const cleaningNotRelocked = oeffnungenMitSperre
    .filter(({ o, sperre }) => isAllowedReinigungOpening(o, sperre, cleaningUser, enforcedFrom))
    .flatMap(({ o, sperre }) => {
      const deadline = reinigungRelockDeadline(o.startTime, reinigungMaxMinuten, reinigungsFenster, subTz);
      const sperrzeitCoversDeadline = sperre!.endetAt === null || sperre!.endetAt >= deadline;
      const relockAt = verschluesse.find((v) => v.startTime > o.startTime)?.startTime ?? null;
      return sperrzeitCoversDeadline && isCleaningNotRelocked(deadline, relockAt, now)
        ? [{ entryId: o.id, startTime: o.startTime, deadline, relockAt, note: o.note }]
        : [];
    });

  const toControl = (k: typeof kontrollAnforderungen[number]): StrafbuchControlOffense => ({
    id: k.id,
    code: k.code,
    deadline: k.deadline,
    fulfilledAt: k.fulfilledAt ?? null,
    entryStartTime: k.entry?.startTime ?? null,
    backdated: !!(k.fulfilledAt && k.entry?.startTime &&
      k.entry.startTime.getTime() < k.deadline.getTime() &&
      k.fulfilledAt.getTime() > k.deadline.getTime()),
    kommentar: k.kommentar,
    entryNote: k.entry?.note ?? null,
  });

  // Wie toControl, aber liest den erzeugten Eintrag aus autoMarkedEntry statt entry (die
  // Kontrolle wurde nie erfüllt — das ist ja der Punkt — und `backdated` ist hier bedeutungslos).
  const toAutoRemovedControl = (k: typeof kontrollAnforderungen[number]): StrafbuchControlOffense => ({
    id: k.id,
    code: k.code,
    deadline: k.deadline,
    fulfilledAt: null,
    entryStartTime: k.autoMarkedEntry?.startTime ?? null,
    backdated: false,
    kommentar: k.kommentar,
    entryNote: k.autoMarkedEntry?.note ?? null,
  });

  return {
    unauthorizedOpenings,
    lateControls: kontrollAnforderungen
      .filter((k) => mapAnforderungStatus(k, k.entry?.startTime ?? null, now) === "late")
      .map(toControl),
    rejectedControls: kontrollAnforderungen
      .filter((k) => k.entry?.verifikationStatus === "rejected")
      .map(toControl),
    autoRemovedControls: kontrollAnforderungen
      .filter((k) => k.autoMarkedRemovedAt !== null)
      .map(toAutoRemovedControl),
    reinigungLimitViolations,
    wrongDeviceViolations,
    erektionViolations,
    pauseOverageViolations,
    missedOrgasmInstructions: orgasmusAnforderungen
      .filter((a) => a.art === "ANWEISUNG" && a.withdrawnAt === null && a.fulfilledAt === null && a.endetAt < now)
      .sort((a, b) => b.endetAt.getTime() - a.endetAt.getTime())
      .map((a) => ({ id: a.id, endetAt: a.endetAt, nachricht: a.nachricht, requiredArt: a.vorgegebeneArt, istStrafe: a.istStrafe })),
    missedSessions: sessionAnforderungen
      .sort((a, b) => (b.endetAt?.getTime() ?? 0) - (a.endetAt?.getTime() ?? 0))
      .map((s) => ({ id: s.id, endetAt: s.endetAt as Date, nachricht: s.nachricht, categoryName: s.deviceCategory?.name ?? null, istStrafe: s.istStrafe })),
    lateLocks,
    cleaningNotRelocked,
    strafeRecords: strafeRecordsRaw.map((r) => ({
      refId: r.refId,
      offenseType: r.offenseType,
      status: r.status,
      bestraftDatum: r.bestraftDatum,
      notiz: r.notiz,
      reason: r.reason,
      judgedBy: r.judgedBy,
      erledigtAt: r.erledigtAt,
      gemeldetAt: r.gemeldetAt,
      nachweisUrl: r.nachweisUrl,
      erledigungNotiz: r.erledigungNotiz,
      ablehnungGrund: r.ablehnungGrund,
    })),
  };
}
