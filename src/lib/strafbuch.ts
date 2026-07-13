import { prisma } from "@/lib/prisma";
import { mapAnforderungStatus } from "@/lib/utils";
import { activeVerschlussAnforderungWhere } from "@/lib/queries";
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
  missedLockRequests: {
    id: string;
    endetAt: Date;
    nachricht: string | null;
    categoryName: string | null;
  }[];
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

/** Computes the Strafbuch for a user: unauthorized openings during Sperrzeiten, late and
 *  rejected Kontrollen, REINIGUNG-limit violations, plus the punished-marker records.
 *  Single source of truth shared by the admin Strafbuch page and the MCP tool. */
export async function buildStrafbuch(userId: string, now: Date = new Date()): Promise<StrafbuchData> {
  const [user, oeffnungen, sperrzeiten, kontrollAnforderungen, strafeRecordsRaw, orgasmusAnforderungen, sessionAnforderungen, pauseEntries, missedLockAnforderungen] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: {
      reinigungErlaubt: true, reinigungMaxMinuten: true, reinigungMaxProTag: true,
      toiletteErlaubt: true, toiletteMaxMinuten: true, toiletteMaxProTag: true,
      plugReinigungErlaubt: true, plugReinigungMaxMinuten: true, plugReinigungMaxProTag: true,
      plugToiletteMaxMinuten: true,
    } }),
    prisma.entry.findMany({ where: { userId, type: "OEFFNEN" }, orderBy: { startTime: "desc" } }),
    prisma.verschlussAnforderung.findMany({ where: { userId, art: "SPERRZEIT", ...activeVerschlussAnforderungWhere(now) } }),
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

  // Falsches Gerät: LIVE aus den Einträgen abgeleitet (Flag falschesGeraet) — keine automatische
  // Bestrafung mehr; ob geahndet wird, entscheidet die Keyholderin (AI) oder der Admin.
  const wrongDeviceEntries = await prisma.entry.findMany({
    where: { userId, type: "VERSCHLUSS", falschesGeraet: true },
    orderBy: { startTime: "desc" },
    include: { device: { select: { name: true } } },
  });
  const wrongDeviceViolations = wrongDeviceEntries.map((e) => ({
    entryId: e.id, startTime: e.startTime, note: e.note, deviceName: e.device?.name ?? null,
  }));

  // Versäumte Verschluss-Anforderungen: Frist (endetAt) abgelaufen, ohne dass eingeschlossen wurde
  // → ERKENNUNG (analog zur versäumten Session); Urteil durch Keyholderin (AI) oder Admin.
  const missedLockRequests = missedLockAnforderungen
    .slice()
    .sort((a, b) => (b.endetAt?.getTime() ?? 0) - (a.endetAt?.getTime() ?? 0))
    .map((a) => ({ id: a.id, endetAt: a.endetAt as Date, nachricht: a.nachricht, categoryName: a.deviceCategory?.name ?? null }));

  // Unauthorized openings — an OEFFNEN inside an active Sperrzeit. A REINIGUNG opening is
  // permitted when both the user flag and the Sperrzeit allow cleaning. System-authored openings
  // (source="system", the inspection-escalation auto-mark) are EXCLUDED: that's the sub's
  // presumed removal already counted once as `autoRemovedControls` — it's not a willful action by
  // the sub, so flagging it a second time here would double-punish a single ambiguous event.
  const unauthorizedOpenings = oeffnungen
    .filter((o) => o.source !== "system")
    .map((o) => ({
      o,
      sperre: sperrzeiten.find((s) =>
        o.startTime >= s.createdAt &&
        (s.endetAt === null || o.startTime < s.endetAt) &&
        (s.withdrawnAt === null || s.withdrawnAt > o.startTime),
      ),
    }))
    .filter(({ o, sperre }) => {
      if (!sperre) return false;
      const allowedReinigung = o.oeffnenGrund === "REINIGUNG" && userReinigungErlaubt && sperre.reinigungErlaubt;
      const allowedToilette = o.oeffnenGrund === "TOILETTE" && userToiletteErlaubt && sperre.toiletteErlaubt;
      return !allowedReinigung && !allowedToilette && !isOrgasmusOpenAllowed(o.startTime);
    })
    .map(({ o, sperre }) => ({
      id: o.id,
      startTime: o.startTime,
      note: o.note,
      sperrzeitEndetAt: sperre!.endetAt,
      sperrzeitIndefinite: sperre!.endetAt === null,
    }));

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
    wrongDeviceViolations,
    missedLockRequests,
    erektionViolations,
    pauseOverageViolations,
    missedOrgasmInstructions: orgasmusAnforderungen
      .filter((a) => a.art === "ANWEISUNG" && a.withdrawnAt === null && a.fulfilledAt === null && a.endetAt < now)
      .sort((a, b) => b.endetAt.getTime() - a.endetAt.getTime())
      .map((a) => ({ id: a.id, endetAt: a.endetAt, nachricht: a.nachricht, requiredArt: a.vorgegebeneArt, istStrafe: a.istStrafe })),
    missedSessions: sessionAnforderungen
      .sort((a, b) => (b.endetAt?.getTime() ?? 0) - (a.endetAt?.getTime() ?? 0))
      .map((s) => ({ id: s.id, endetAt: s.endetAt as Date, nachricht: s.nachricht, categoryName: s.deviceCategory?.name ?? null, istStrafe: s.istStrafe })),
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
