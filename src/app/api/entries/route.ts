import { uploadsLinkable } from "@/lib/uploadOwnership";
import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { requireApi } from "@/lib/authGuards";
import { prisma } from "@/lib/prisma";
import { boxPhotoReused, detectKeyInBoxInBackground, markBoxPhotoDueIfBoxLocked } from "@/lib/boxPhotoDueService";
import { deriveSealCode, inspectionCodeRequired, plannedVerification, initialVerificationStatus, type InspectionVerification } from "@/lib/kontrolleService";
import { DEVICE_BEARING_TYPES, validateEntryPayload, parseRotation, BOX_PHOTO_TYPES, parseOrgasmusArtBase, lockmeboxEnabled } from "@/lib/constants";
import { orgasmusValueAllowed, validOeffnenCodes } from "@/lib/reasonsService";
import { isDevBypassEnabled } from "@/lib/devMode";
import { validateDeviceOwnership, releaseLockPeriodsOnOpenDetailed, type CleaningBlockReason, prepareWearEntry, getLatestKgEntry, getOpenLockRequest, subVisibleKontrolleWhere } from "@/lib/queries";
import { resolveInspectionTarget, isKgTarget, inspectionTargetWhere } from "@/lib/inspectionTarget";
import { entryGuardError, entryGuardCode } from "@/lib/entryErrors";
import { isUniqueConstraintOn } from "@/lib/prismaErrors";
import { setBoxCommandForUser, boxCommandForEntry } from "@/lib/boxCommand";
import { announceBoxCommand } from "@/lib/boxCommandNotify";
import { deviceCheckApplies, runDeviceCheck } from "@/lib/deviceCheckService";
import { codeChangeCheckApplies, runCodeChangeCheck } from "@/lib/lockboxCodeCheckService";
import { runInspectionVerification } from "@/lib/inspectionVerificationService";
import { structuredLog } from "@/lib/serverLog";
import { applyEntryFulfilment, applyEntryAftermath } from "@/lib/entryFulfilment";
import { lockAwaitsBolt, openAwaitsBolt, findPendingLockTx, findPendingOpenTx } from "@/lib/lockCommit";
import { boltFieldsFor } from "@/lib/lockPending";
import { parseOfflineCapture } from "@/lib/offlineCapture";
import { resolveEntryStart, startAfter, startIsNow } from "@/lib/entryStart";
import { triggeredWhere } from "@/lib/delayedTrigger";
import { getMidnightToday, APP_TZ } from "@/lib/utils";
// Fork: Airlock-NFC, Sessions, Körperregion, Pausen, KI-Keyholderin, Belohnungs-Ökonomie.
import { verifyForVerschluss, verifyForKontrolle } from "@/lib/airlock/verify";
import { activateAirlockLock, retireLock } from "@/lib/airlock/service";
import { getActiveSessionForCategory, fulfillSessionAnforderung, getActiveSessionAnforderung } from "@/lib/sessionService";
import { findRegionConflict, type RegionConflict } from "@/lib/bodyRegion";
import { getActivePause, pauseReasonsForDevice, type PauseDevice } from "@/lib/pauseService";
import { parseCleaningWindows, activeCleaningWindow } from "@/lib/cleaningService";
import { reactToSubEvent } from "@/lib/aiKeyholder/keyholderService";
import { autoGrantReachedGoals } from "@/lib/belohnung";

export async function GET() {
  const session = await requireApi();
  if (session instanceof NextResponse) return session;

  const entries = await prisma.entry.findMany({
    where: { userId: session.user.id },
    orderBy: { startTime: "desc" },
    select: {
      id: true, type: true, startTime: true, imageUrl: true, note: true,
      orgasmusArt: true, kontrollCode: true, oeffnenGrund: true, verifikationStatus: true,
      deviceId: true,
    },
    take: 200,
  });

  return NextResponse.json(entries);
}

/** Fork: die zwei Fälle, die kein 400 sind — ein bereits belegter Zustand ist ein Konflikt, kein Bad Request. */
const GUARD_STATUS: Record<string, number> = { REGION_CONFLICT: 409, PAUSE_ALREADY_ACTIVE: 409 };

/** Fork: Session-Einträge tragen ihr Gerät wie die Trage-Einträge (Kategorie mit `isSessionCategory`). */
const SESSION_TYPES: readonly string[] = ["SESSION_BEGIN", "SESSION_END"];

export async function POST(req: NextRequest) {
  const session = await requireApi();
  if (session instanceof NextResponse) return session;

  const body = await req.json();
  // verifikationStatus is never accepted from client – set server-side only
  const { type, startTime, imageUrl, imageExifTime, note, oeffnenGrund, orgasmusArt, kontrollCode, deviceId, imageRotation, codeImageUrl, codeReadable, keyInBox, boxImageUrl, boxImageRotation, clientRequestId, erektionGemeldet, videoUrl, sessionGoalAchieved, pauseDevice } = body;
  // Fork: welche Typen ein Gerät tragen — Upstreams Liste plus die Session-Einträge.
  const bearsDevice = DEVICE_BEARING_TYPES.includes(type) || SESSION_TYPES.includes(type);

  const devBypass = isDevBypassEnabled(req.headers.get("host"));
  // Reason-Codes gegen die (ggf. angepasste) Liste DES SESSION-USERS validieren; null-Config → Built-ins.
  const reasonUser = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { orgasmusArtenConfig: true, oeffnenGruendeConfig: true },
  });
  const validationError = validateEntryPayload(body, { allowFuture: devBypass }, {
    orgasmAllowed: (v) => orgasmusValueAllowed(v, reasonUser?.orgasmusArtenConfig),
    openingCodes: validOeffnenCodes(reasonUser?.oeffnenGruendeConfig),
  });
  if (validationError) return NextResponse.json({ error: validationError }, { status: 400 });
  // Jedes mitgeschickte Bild muss dem Träger selbst gehören (`uploadOwnership.ts`).
  if (!(await uploadsLinkable([imageUrl, codeImageUrl, boxImageUrl], [session.user.id]))) {
    return NextResponse.json({ error: "INVALID_IMAGE_URL" }, { status: 400 });
  }

  // EINE Normalisierung für Persistenz UND Box-Kommando — sonst könnte die Box einem Wert folgen, den
  // der Eintrag nicht dokumentiert. Nicht-Boolean ist oben ausgeschlossen; bleibt: fehlt = null.
  const keyInBoxDeclared: boolean | null = keyInBox ?? null;

  // Dieselbe Normalisierung für Prüfung UND Persistenz. Zweimal hingeschrieben könnte die Prüfung
  // einen Wert nachschlagen, den die Zeile gar nicht speichert.
  const requestKey: string | null = typeof clientRequestId === "string" && clientRequestId ? clientRequestId : null;

  // Offline erfasst? Dann zählt die CLIENT-Erfassungszeit als Eintrags- UND Fristen-Stichtag — die
  // EINZIGE Lockerung der Server-Uhr-Regel auf dem Sub-Pfad (Begründung in `offlineCapture.ts`).
  const { capturedOffline, capturedAt } = parseOfflineCapture(body);
  // Der wirksame Eintrags-Zeitpunkt: offline die Erfassungszeit des Clients, sonst die (frei
  // wählbare) Formular-Zeit. Ohne Offline-Flag `capturedAt === null` — also online unverändert.
  //
  // „Jetzt" (`startIsNow`, `entryStart.ts`): der Träger hat die Zeit nicht angefasst, dann gilt die
  // Server-Uhr auf die Sekunde — dieselbe, nach der der Riegel datiert. Das Formular kennt nur
  // Minuten und schickte sonst 12:06:00 gegen einen Eintrag von 12:06:10.
  const isNowStart = startIsNow(body, type, capturedOffline);
  let effectiveStart = resolveEntryStart({ capturedAt, startTime, isNow: isNowStart, now: new Date() });
  // Stichtag für Fristen/Vergehen (`applyEntryFulfilment`): offline die Erfassungszeit, sonst die
  // Server-Uhr im Moment der Einreichung.
  const fulfilmentAt = capturedAt ?? new Date();

  // Derselbe Versuch, ein zweites Mal? Dann den vorhandenen Eintrag zurückgeben statt einen neuen
  // anzulegen. Wozu der Stempel da ist, steht bei `entryRequest()`.
  //
  // Antwort ohne 201: angelegt wurde in DIESEM Aufruf nichts. Der Client sieht trotzdem Erfolg, und
  // das ist richtig — sein Wunsch ist erfüllt, nur eben beim ersten Versuch.
  if (requestKey) {
    const schonDa = await prisma.entry.findFirst({ where: { clientRequestId: requestKey, userId: session.user.id } });
    if (schonDa) return NextResponse.json(schonDa);
  }

  // Fork: Reinigung/Toilette laufen ausschliesslich über die Pause-Funktion (PAUSE_BEGIN/PAUSE_END) —
  // nicht über ein volles Öffnen/Trage-Ende des Trägers. Der Keyholder-Pfad ist eine eigene Route.
  if ((type === "OEFFNEN" || type === "WEAR_END") && (oeffnenGrund === "REINIGUNG" || oeffnenGrund === "TOILETTE")) {
    return NextResponse.json({ error: "CLEANING_VIA_PAUSE" }, { status: 400 });
  }

  // Replay-Schutz fürs Box-Foto (Kontrolle): dieselbe Aufnahme darf nicht ein zweites Mal als Nachweis
  // dienen — Begründung an `boxPhotoReused`.
  if (BOX_PHOTO_TYPES.has(type) && boxImageUrl && await boxPhotoReused(boxImageUrl)) {
    return NextResponse.json({ error: "BOX_PHOTO_REUSED" }, { status: 400 });
  }

  // Wrap state-check + create in a transaction to prevent TOCTOU races
  let entry: Awaited<ReturnType<typeof prisma.entry.create>>;
  // In der Transaktion entschieden, ausserhalb für den Instant-Push wiederverwendet.
  let boxCmd: "lock" | "open" | null = null;

  let withdrawnLockPeriod = false;
  let cleaningBlock: CleaningBlockReason | null = null;
  let lockStartTime: Date | null = null;
  // Schliesst dieser VERSCHLUSS eine Reinigungspause ab? In der Transaktion aus demselben
  // Lock-Eintrag abgeleitet, den der Guard ohnehin liest — nach dem Commit löst er die Kontrolle aus.
  let endsCleaningPause = false;
  // Wartet dieser Verschluss auf den Riegel? Dann ist er nur der AUFRUF: geschrieben, aber für
  // jede Ableitung unsichtbar, bis die Box meldet (`lockCommit.ts`, docs/riegel-konzept.md).
  // In der Transaktion entschieden, danach für die übersprungenen Nacharbeiten gebraucht.
  let awaitsBolt = false;
  let requiredAnforderungDeviceIds: string[] = [];
  // In der Transaktion abgeleitet (braucht den Lock-Eintrag), NACH dem Commit für die eigentliche
  // Prüfung wiederverwendet — deshalb hier draussen. null = keine PRUEFUNG mit Foto.
  let verification: InspectionVerification | null = null;
  // Das Gerät, das im Kontroll-Foto zu sehen sein sollte — beim KG das verschlossene, bei einer
  // Trage-Kontrolle das gezeigte. Aus derselben Ziel-Auflösung wie `verification`, damit
  // Code-Prüfung und Geräte-Check dasselbe Ziel meinen.
  let inspectionExpectedDeviceId: string | null = null;
  // Bildersafe-Codewechsel (#115): wie beim Geräte-Check entscheidet EINE Bedingung den
  // "pending"-Startwert und den Lauf nach dem Commit. Vor der Transaktion, weil sie die
  // Foto-Prüfungs-Einstellung liest.
  const codeCheckRuns = type === "VERSCHLUSS" && (await codeChangeCheckApplies(codeImageUrl));

  // Fork — Region-Exklusivität VORAB (ausserhalb der Transaktion) berechnen: findRegionConflict nutzt
  // den globalen prisma-Client. INNERHALB der interaktiven $transaction (connection_limit=1 → nur EINE
  // Verbindung, von der Transaktion gehalten) würde dieser Query ewig auf eine zweite Verbindung
  // warten und die Transaktion ins Timeout treiben (Deadlock). Der eigentliche Abbruch (throw)
  // passiert weiterhin IN der Transaktion, damit Status- und Fehler-Handling unverändert bleiben.
  let regionConflict: RegionConflict | null = null;
  if ((type === "WEAR_BEGIN" || type === "SESSION_BEGIN") && deviceId) {
    const rcDev = await prisma.device.findUnique({ where: { id: deviceId }, select: { categoryId: true } });
    if (rcDev?.categoryId) regionConflict = await findRegionConflict(session.user.id, rcDev.categoryId);
  }

  // Fork — Airlock-NFC (Weg A): den Tag-Nachweis VOR der Transaktion prüfen — das ist ein Netz-Call
  // zur Airlock-API und darf (wie regionConflict oben) nicht in die connection_limit=1-Transaktion.
  // Rein additiv: ohne `body.airlock` und ohne Airlock-Vorgabe bleibt alles unverändert. Siehe
  // docs/AIRLOCK_NFC.md § 4.5/4.6.
  let airlockProof: { code: string; uid: string } | null = null;
  let kontrolleAirlockValidated = false;
  // Beim Ablegen (OEFFNEN) zu tötendes Lock — in der Transaktion aus dem aktiven Verschluss
  // ermittelt, NACH dem Commit best-effort retired.
  let airlockToRetire: string | null = null;
  if (type === "VERSCHLUSS") {
    // Vorgabe aus der dringendsten offenen Anforderung (falls gesetzt): genau dieses Lock ist Pflicht.
    const mandate = await getOpenLockRequest(session.user.id);
    const mandatedAirlockCode = mandate?.airlockCode ?? null;
    if (body.airlock) {
      const r = await verifyForVerschluss(session.user.id, body.airlock, mandatedAirlockCode);
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
      airlockProof = { code: r.code, uid: r.uid };
      // Sicherheits-Gate: ein ZUGEWIESENES Lock muss vom Sub vorab per Tag-Scan verifiziert worden
      // sein (bestätigt, dass der Tag liest), bevor es zum Verschluss genutzt werden darf.
      const alLock = await prisma.airlockLock.findUnique({ where: { code: r.code }, select: { assignedUserId: true, verifiedAt: true } });
      if (alLock?.assignedUserId === session.user.id && !alLock.verifiedAt) {
        return NextResponse.json({ error: "AIRLOCK_LOCK_UNVERIFIED" }, { status: 400 });
      }
    } else if (mandatedAirlockCode) {
      // Die Keyholderin hat ein Airlock-Lock vorgegeben → der Verschluss MUSS per NFC damit erfolgen.
      return NextResponse.json({ error: "AIRLOCK_VERSCHLUSS_REQUIRES_TAG" }, { status: 400 });
    }
  }
  // Nur die KG-Kontrolle (ohne Gerät — mit Gerät ist es eine Trage-Kontrolle, siehe
  // `resolveInspectionTarget`): war der aktive Verschluss ein Airlock, ersetzt der NFC-Scan die
  // Handschrift-Code-Prüfung. `getLatestKgEntry` ist dieselbe Quelle wie für den Lock-Zustand;
  // `airlockUid` steht nicht in ihrem schmalen `select` und wird gezielt nachgeladen.
  if (type === "PRUEFUNG" && !deviceId) {
    const latestKg = await getLatestKgEntry(session.user.id);
    const activeAirlockUid = latestKg?.type === "VERSCHLUSS"
      ? (await prisma.entry.findUnique({ where: { id: latestKg.id }, select: { airlockUid: true } }))?.airlockUid ?? null
      : null;
    if (activeAirlockUid) {
      if (!body.airlock) return NextResponse.json({ error: "AIRLOCK_CONTROL_REQUIRES_TAG" }, { status: 400 });
      const r = await verifyForKontrolle(activeAirlockUid, body.airlock);
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
      kontrolleAirlockValidated = true;
    }
  }

  try {
    entry = await prisma.$transaction(async (tx) => {
      // Validate deviceId ownership inside transaction (VERSCHLUSS / WEAR_* / PRUEFUNG / SESSION_*)
      if (deviceId && bearsDevice) {
        const device = await validateDeviceOwnership(deviceId, session.user.id, tx);
        if (!device) throw entryGuardError("INVALID_DEVICE");
      }

      // WEAR_BEGIN / WEAR_END: shared validation lives in lib/queries.ts (single source of truth).
      // `effectiveStart`, nicht das rohe `startTime`: die Reihenfolge-Prüfung (`TIME_BEFORE`) muss
      // GEGEN DIE ZEIT laufen, mit der die Zeile gespeichert wird — bei einem offline erfassten
      // Eintrag ist das die Erfassungszeit, nicht die (u.U. abweichende) Formular-Zeit. Sonst würde
      // eine gültige Offline-Tragezeit gegen eine andere Uhr geprüft und fälschlich mit 400
      // abgewiesen — und die Warteschlange verwirft ein 400 als „schlechte Daten" (Datenverlust).
      let wearCategoryId: string | null = null;
      if (type === "WEAR_BEGIN" || type === "WEAR_END") {
        const wearResult = await prepareWearEntry(tx, session.user.id, type, deviceId, effectiveStart, imageUrl, isNowStart);
        if (!wearResult.ok) throw entryGuardError(wearResult.code);
        effectiveStart = wearResult.start;
        wearCategoryId = wearResult.categoryId;
        // Fork — Körperregion-Exklusivität: kein zweites Gerät derselben Region gleichzeitig
        // (z.B. Plug + Anal-Session).
        if (type === "WEAR_BEGIN" && regionConflict) {
          throw Object.assign(entryGuardError("REGION_CONFLICT"), { _blocking: regionConflict.blockingCategoryName });
        }
      }

      // Fork — SESSION_BEGIN / SESSION_END: gegen den aktiven Session-Zustand dieser Kategorie prüfen.
      let sessionCategoryId: string | null = null;
      let sessionBeginTime: Date | null = null;
      if (type === "SESSION_BEGIN" || type === "SESSION_END") {
        if (!deviceId) throw entryGuardError("SESSION_DEVICE_REQUIRED");
        const dev = await tx.device.findUnique({
          where: { id: deviceId },
          select: { categoryId: true, category: { select: { isSessionCategory: true, requiresVideo: true } } },
        });
        if (!dev?.categoryId || !dev.category?.isSessionCategory) {
          throw entryGuardError("SESSION_WRONG_CATEGORY");
        }
        sessionCategoryId = dev.categoryId;
        const active = await getActiveSessionForCategory(session.user.id, dev.categoryId, tx);
        if (type === "SESSION_BEGIN" && active) throw entryGuardError("SESSION_ALREADY_ACTIVE");
        // Körperregion-Exklusivität: kein zweites Gerät derselben Region (z.B. Anal-Session bei getragenem Plug).
        if (type === "SESSION_BEGIN" && regionConflict) {
          throw Object.assign(entryGuardError("REGION_CONFLICT"), { _blocking: regionConflict.blockingCategoryName });
        }
        if (type === "SESSION_END") {
          if (!active) throw entryGuardError("SESSION_NOT_ACTIVE");
          effectiveStart = startAfter(effectiveStart, active.startTime, isNowStart);
          if (effectiveStart <= active.startTime) throw entryGuardError("TIME_BEFORE");
          // Video-Pflicht: eine offene Session-Anforderung (Admin/KI) überschreibt den Kategorie-Standard.
          const anf = await getActiveSessionAnforderung(session.user.id, dev.categoryId, tx);
          const effRequireVideo = anf ? anf.requireVideo : dev.category.requiresVideo;
          if (effRequireVideo && !videoUrl) throw entryGuardError("SESSION_VIDEO_REQUIRED");
          sessionBeginTime = active.startTime;
        }
      }

      // Fork — Foto-Pflicht aus einer offenen Orgasmus-Anforderung: verlangt die Anforderung im
      // Fenster einen Nachweis, wird ein Orgasmus ohne Foto abgelehnt (das Formular prüft nur vorab).
      // Dieselbe Fenster-Regel wie die Erfüllung (`applyEntryFulfilment`): Eintrags-Zeit, nur
      // bereits ausgelöste Anforderungen.
      if (type === "ORGASMUS" && !imageUrl) {
        const fotoAnforderung = await tx.orgasmusAnforderung.findFirst({
          where: {
            userId: session.user.id, fulfilledAt: null, withdrawnAt: null, fotoPflicht: true,
            beginsAt: { lte: effectiveStart }, endsAt: { gte: effectiveStart },
            ...triggeredWhere(effectiveStart),
          },
          select: { id: true },
        });
        if (fotoAnforderung) throw entryGuardError("ORGASMUS_PHOTO_REQUIRED");
      }

      // Fork — PAUSE_BEGIN / PAUSE_END (Reinigungs-/Toiletten-Pause für KG bzw. Plug).
      if (type === "PAUSE_BEGIN" || type === "PAUSE_END") {
        const dev: PauseDevice | null = pauseDevice === "CAGE" || pauseDevice === "PLUG" ? pauseDevice : null;
        if (!dev) throw entryGuardError("PAUSE_DEVICE_REQUIRED");
        if (type === "PAUSE_END" && !imageUrl) throw entryGuardError("PAUSE_PHOTO_REQUIRED");

        const activePause = await getActivePause(session.user.id, dev, tx);
        if (type === "PAUSE_BEGIN") {
          if (activePause) throw entryGuardError("PAUSE_ALREADY_ACTIVE");
          // Ist das Gerät überhaupt in Gebrauch?
          if (dev === "CAGE") {
            const latestKg = await getLatestKgEntry(session.user.id, tx);
            if (!latestKg || latestKg.type !== "VERSCHLUSS") throw entryGuardError("PAUSE_NOT_LOCKED");
            // Airlock: ein physisches Einweg-Lock lässt sich nicht temporär öffnen und wieder
            // schliessen — Reinigungs-/Toiletten-Pause bei aktivem Airlock-Verschluss gesperrt.
            const lockRow = await tx.entry.findUnique({ where: { id: latestKg.id }, select: { airlockUid: true } });
            if (lockRow?.airlockUid) throw entryGuardError("AIRLOCK_NO_TEMP_OPEN");
          }
          if (dev === "PLUG") {
            const latestWear = await tx.entry.findFirst({
              where: { userId: session.user.id, type: { in: ["WEAR_BEGIN", "WEAR_END"] } },
              orderBy: { startTime: "desc" },
              select: { type: true },
            });
            if (!latestWear || latestWear.type !== "WEAR_BEGIN") throw entryGuardError("PAUSE_NOT_WEARING");
          }
          // Grund (Reinigung/Toilette) + Tageslimit gemäss Einstellungen
          const puser = await tx.user.findUnique({
            where: { id: session.user.id },
            select: {
              cleaningAllowed: true, cleaningMaxMinutes: true, cleaningMaxPerDay: true,
              toiletteErlaubt: true, toiletteMaxMinuten: true, toiletteMaxProTag: true,
              plugReinigungErlaubt: true, plugReinigungMaxMinuten: true, plugReinigungMaxProTag: true,
              plugReinigungsFenster: true,
              plugToiletteMaxMinuten: true,
            },
          });
          const pauseReasons = puser
            ? pauseReasonsForDevice(puser, dev)
            : [];
          if (pauseReasons.length > 0) {
            const chosen = pauseReasons.find((r) => r.grund === oeffnenGrund);
            if (!chosen) throw entryGuardError("PAUSE_REASON_REQUIRED");
            const tzP = session.user.timezone ?? APP_TZ;
            if (chosen.maxProTag > 0) {
              // Im tx gezählt (nicht über `pauseBeginCountsToday`, das den globalen Client nutzt —
              // connection_limit=1, siehe regionConflict oben); dieselben where-Bedingungen.
              const todayCount = await tx.entry.count({
                where: {
                  userId: session.user.id, type: "PAUSE_BEGIN", pauseDevice: dev,
                  oeffnenGrund: chosen.grund,
                  startTime: { gte: getMidnightToday(new Date(), tzP) },
                },
              });
              if (todayCount >= chosen.maxProTag) throw entryGuardError("PAUSE_LIMIT_REACHED");
            }
            // Plug-Reinigung nur innerhalb der konfigurierten Tages-Zeitfenster (falls gesetzt).
            if (dev === "PLUG" && chosen.grund === "REINIGUNG" && puser) {
              if (parseCleaningWindows(puser.plugReinigungsFenster).length > 0
                && !activeCleaningWindow(puser.plugReinigungsFenster, new Date(), tzP)) {
                throw entryGuardError("PLUG_REINIGUNG_FENSTER");
              }
            }
          }
        }
        if (type === "PAUSE_END") {
          if (!activePause) throw entryGuardError("PAUSE_NOT_ACTIVE");
          effectiveStart = startAfter(effectiveStart, activePause.startTime, isNowStart);
          if (effectiveStart <= activePause.startTime) throw entryGuardError("TIME_BEFORE");
          // Pause-Überzug wird nicht hier bestraft, sondern im Strafbuch erkannt (buildStrafbuch).
        }
      }

      // tx durchreichen: der Read-then-Write-Guard muss in DERSELBEN Transaktion lesen (TOCTOU).
      if (type === "VERSCHLUSS") {
        const latest = await getLatestKgEntry(session.user.id, tx);
        if (latest?.type === "VERSCHLUSS") throw entryGuardError("ALREADY_LOCKED");
        // Ein schwebender Aufruf zählt für `getLatestKgEntry` bewusst nicht als Verschluss — der
        // Guard oben greift für ihn also nicht, und ohne den hier legte der Träger beliebig viele
        // Aufrufe übereinander an, während die Box auf den ersten wartet.
        if (await findPendingLockTx(tx, session.user.id)) throw entryGuardError("LOCK_ALREADY_PENDING");
        if (latest?.type === "OEFFNEN") {
          effectiveStart = startAfter(effectiveStart, latest.startTime, isNowStart);
          if (effectiveStart <= latest.startTime) throw entryGuardError("TIME_BEFORE");
        }
        endsCleaningPause = latest?.type === "OEFFNEN" && latest.oeffnenGrund === "REINIGUNG";
        awaitsBolt = await lockAwaitsBolt(tx, session.user.id, keyInBoxDeclared, new Date());
      }
      if (type === "OEFFNEN") {
        const latest = await getLatestKgEntry(session.user.id, tx);
        if (!latest || latest.type !== "VERSCHLUSS") throw entryGuardError("NOT_LOCKED");
        effectiveStart = startAfter(effectiveStart, latest.startTime, isNowStart);
        if (effectiveStart <= latest.startTime) throw entryGuardError("TIME_BEFORE");
        // Wie beim Verschluss: eine schwebende Öffnung zählt für `getLatestKgEntry` nicht — ohne
        // diese Sperre legte der Träger Aufruf auf Aufruf, während die Box auf den ersten wartet.
        if (lockmeboxEnabled() && await findPendingOpenTx(tx, session.user.id)) throw entryGuardError("OPEN_ALREADY_PENDING");
        lockStartTime = latest.startTime;
        // Fork — Airlock: war der aktive Verschluss ein Airlock, das Einweg-Lock nach dem Commit töten.
        airlockToRetire = (await tx.entry.findUnique({ where: { id: latest.id }, select: { airlockCode: true } }))?.airlockCode ?? null;
        ({ broke: withdrawnLockPeriod, cleaningBlock } = await releaseLockPeriodsOnOpenDetailed(session.user.id, oeffnenGrund, tx, "user"));
        // LockMeBox: die Öffnung gilt erst mit „Riegel offen" (`lockCommit.ts`, docs/lockmebox.md).
        awaitsBolt = await openAwaitsBolt(tx, session.user.id, latest.keyInBox, withdrawnLockPeriod, new Date());
      }

      // WELCHES ZIEL beantwortet diese Einreichung? Ohne Gerät der KG (Bestandsverhalten), mit
      // einem Gerät einer Trage-Kategorie deren Kontrolle. Dieselbe Auflösung wie beim Anlegen der
      // Anforderung — sonst könnte eine Kontrolle auf ein Ziel zeigen, das die Erfüllung anders liest.
      const resolvedTarget = type === "PRUEFUNG" && imageUrl
        ? await resolveInspectionTarget(session.user.id, { deviceId: deviceId || null }, tx)
        : null;
      if (resolvedTarget && !resolvedTarget.ok) throw entryGuardError("INVALID_DEVICE");
      const inspectionTarget = resolvedTarget?.ok ? resolvedTarget.target : null;
      // Das Gerät, an dem die Code-Pflicht hängt: bei einer Trage-Kontrolle das GEZEIGTE (es steht
      // im Foto), beim KG das verschlossene (das Foto zeigt das Siegel, nicht zwingend das Gerät).
      const submissionDeviceId = inspectionTarget && !isKgTarget(inspectionTarget)
        ? inspectionTarget.deviceId
        : inspectionTarget?.activeDeviceId ?? null;
      // Der GERÄTE-CHECK bekommt das Gerät nur beim KG-Ziel. `gatherDeviceReferences` sammelt
      // ausschliesslich Geräte der eingebauten Kategorie, und der Vision-Prompt fragt nach einem
      // Keuschheitsgürtel — für ein Trage-Gerät fände `checkDeviceInPhoto` keine Referenz und
      // meldete „nicht prüfbar" (error) an JEDER Trage-Kontrolle. Ohne Gerät läuft der Check gar
      // nicht und die Zeile endet auf `null` = „nicht geprüft", was der Wahrheit entspricht.
      // Trage-Ziele hier mitzuprüfen ist ein eigenes Stück Arbeit (Referenzen + Prompt je Kategorie).
      inspectionExpectedDeviceId = inspectionTarget && isKgTarget(inspectionTarget)
        ? inspectionTarget.activeDeviceId
        : null;
      // Was an dieser Einreichung zu prüfen ist — EINE Ableitung für den Startwert unten, für die
      // Prüfung nach dem Commit und für die Art der Erfüllung. Die Siegel-Nummer kommt aus dem
      // Lock-Eintrag, den nur das KG-Ziel mitbringt (`lockEntry`); eine Trage-Kontrolle hat keine.
      verification = inspectionTarget
        ? plannedVerification({
            submittedCode: kontrollCode,
            codeRequired: await inspectionCodeRequired(submissionDeviceId, tx),
            sealCode: deriveSealCode(inspectionTarget.lockEntry),
          })
        : null;
      // "pending" nur, wenn danach wirklich eine Prüfung läuft, die es ersetzt (siehe unten);
      // "not_required", wenn das Gerät gar keinen Code verlangt und kein Siegel aktiv ist.
      //
      // Fork — Airlock-Kontrolle: der vorab geprüfte Tag-Scan IST der Nachweis; es folgt keine
      // Foto-Prüfung, die den Startwert ersetzen müsste (siehe `runInspectionVerification` unten).
      const initialVerifikationStatus = kontrolleAirlockValidated
        ? "verified"
        : verification ? initialVerificationStatus(verification) : null;
      // Dasselbe für den Geräte-Check, der ebenfalls erst nach dem Commit läuft. Die Bedingung kommt
      // aus deviceCheckService — derselbe Ausdruck entscheidet unten, ob der Lauf gestartet wird, der
      // dieses "pending" wieder abräumen MUSS. Zwei getrennt hingeschriebene Bedingungen könnten
      // auseinanderlaufen und die Zeile für immer auf "pending" stehen lassen.
      const initialDeviceCheck = deviceCheckApplies(type, imageUrl) ? "pending" : null;

      const created = await tx.entry.create({
        data: {
          userId: session.user.id,
          // Der Stempel wandert MIT in die Zeile — er ist der einzige Grund, warum der zweite
          // Versuch oben als derselbe erkannt wird.
          clientRequestId: requestKey,
          type,
          startTime: effectiveStart,
          // Offline erfasst: kleine Notiz „offline erfasst" in beiden Sichten; nur der Sub-Pfad
          // setzt es (der Keyholder-Pfad ist eine eigene Route, die dieses Feld nie schreibt).
          capturedOffline,
          imageUrl: imageUrl || null,
          imageExifTime: imageExifTime ? new Date(imageExifTime) : null,
          note: note || null,
          oeffnenGrund: oeffnenGrund || null,
          orgasmusArt: orgasmusArt || null,
          kontrollCode: kontrollCode || null,
          verifikationStatus: initialVerifikationStatus,
          deviceCheck: initialDeviceCheck,
          // PRUEFUNG trägt seit v5.0.1 ebenfalls ein Gerät: bei einer Trage-Kontrolle ist es das
          // gezeigte und damit das einzige, woran später erkennbar ist, WAS kontrolliert wurde.
          deviceId: bearsDevice
            ? (deviceId || null)
            : null,
          // Fork: Pausen tragen statt eines Geräts die Geräte-ART (CAGE|PLUG).
          pauseDevice: (type === "PAUSE_BEGIN" || type === "PAUSE_END") ? (pauseDevice || null) : null,
          // Bildersafe: versiegeltes Schlüsselbox-Code-Foto (nur VERSCHLUSS)
          codeImageUrl: type === "VERSCHLUSS" ? (codeImageUrl || null) : null,
          codeReadable: type === "VERSCHLUSS" && codeImageUrl ? (codeReadable ?? null) : null,
          codeChangeCheck: codeCheckRuns ? "pending" : null,
          keyInBox: type === "VERSCHLUSS" ? keyInBoxDeclared : null,
          // Der Verschluss gilt sofort — ausser er wartet auf den Riegel. Die Regel steht in
          // `lockPending.ts`, weil JEDER Erzeuger eines VERSCHLUSS sie braucht.
          ...boltFieldsFor(type, effectiveStart, awaitsBolt),
          // `keyDetected` bleibt hier ungesetzt (null) — das Urteil fällt nach dem Commit (siehe unten).
          boxImageUrl: BOX_PHOTO_TYPES.has(type) ? (boxImageUrl || null) : null,
          // Fork — Erektion während einer Reinigungs-/Toiletten-Pause gemeldet (nur PAUSE_END).
          erektionGemeldet: type === "PAUSE_END" && erektionGemeldet === true ? true : undefined,
          // Fork — Session: Video-Beweis + Ziel-erreicht (nur SESSION_END).
          videoUrl: type === "SESSION_END" ? (videoUrl || null) : null,
          sessionGoalAchieved: type === "SESSION_END" && typeof sessionGoalAchieved === "boolean" ? sessionGoalAchieved : undefined,
          // Fork — Airlock-NFC: bei per Tag validiertem Verschluss die Airlock-Nummer + gebundene UID
          // festhalten (Anker für die spätere NFC-Kontrolle). null = normaler Verschluss ohne Airlock.
          airlockCode: type === "VERSCHLUSS" ? (airlockProof?.code ?? null) : null,
          airlockUid: type === "VERSCHLUSS" ? (airlockProof?.uid ?? null) : null,
        },
      });

      // KontrollAnforderung verknüpfen + fulfilledAt server-seitig setzen (unveränderlich).
      // Nur bereits AUSGELÖSTE Anforderungen (wirksamAb erreicht) — sonst könnte ein zufällig
      // kollidierender Selbstkontroll-Code eine noch unsichtbare, geplante Auto-Kontrolle erfüllen.
      //
      // ZWEI Zuordnungswege, und der Unterschied ist der Kern des Geräte-Toggles:
      //
      // 1. Mit Code-Pflicht ist der Code der SCHLÜSSEL — er sagt, WELCHE Anforderung dieses Foto
      //    beantwortet. Ohne passenden Code wird nichts erfüllt; eine freiwillige Selbstkontrolle
      //    lässt eine offene Anforderung also unberührt.
      // 2. Ohne Code-Pflicht gibt es keinen Schlüssel. Dann beantwortet das Foto die EINE offene
      //    Anforderung — es gibt nie mehr als eine (requestKontrolle lehnt eine zweite mit
      //    INSPECTION_ALREADY_ACTIVE ab, der Poller zieht überschneidende Auto-Kontrollen zurück).
      //    Damit erfüllt hier auch eine freiwillig erfasste Kontrolle die offene Anforderung — das
      //    ist gewollt: ohne Code ist eine „freiwillige" von einer „beantworteten" nicht mehr zu
      //    unterscheiden, und die Einreichung ist da.
      //
      // `orderBy deadline asc` + `take 1` statt updateMany: sollte der Überschneidungs-Schutz doch
      // einmal zwei Zeilen durchlassen (er ist ein Best-Effort-Read-then-Write, siehe
      // requestKontrolle), erfüllt ein Foto genau EINE — die dringendste — statt beide auf einmal.
      // Was dieser Eintrag abhakt (Kontrolle, Verschluss-Anforderungen samt Sperrzeiten,
      // Orgasmus-Anforderung) — dieselbe Logik wie auf dem Keyholder-Pfad, siehe
      // entryFulfilment.ts. `at = fulfilmentAt`: normalerweise die SERVER-Uhr, nie die frei
      // wählbare Eintrags-Zeit (sonst datierte sich jeder Sub aus jeder Frist heraus). AUSNAHME:
      // ein offline erfasster Eintrag trägt die Client-Erfassungszeit — die bewusst akzeptierte
      // Lockerung (Begründung in `offlineCapture.ts`), streng aufs Offline-Flag gegatet. Die
      // Ziel-Schranke reist mit, damit ein Plug-Foto keine KG-Kontrolle abhakt.
      //
      // Ein schwebender Aufruf hakt NICHTS ab: eine Verschluss-Anforderung ist mit dem Riegel
      // erfüllt, nicht mit dem Aufruf. Das holt `commitPendingLock` nach, sobald die Box meldet.
      //
      // Fork — Airlock-Kontrolle: der vorab geprüfte Tag-Scan ersetzt die Code-Abfrage. Die
      // dringendste offene KG-Anforderung wird ohne Code-Abgleich erfüllt — mit denselben Schranken
      // wie der Rundum-Weg in `applyEntryFulfilment` (Ziel, Sichtbarkeit, Rückdatierung). Danach
      // läuft die geteilte Erfüllung OHNE Kontroll-Zweig (`verification: null`), sonst schriebe sie
      // dieselbe entryId ein zweites Mal (KontrollAnforderung.entryId ist @unique → P2002).
      if (kontrolleAirlockValidated && inspectionTarget && !awaitsBolt) {
        const nfcKontrolle = await tx.kontrollAnforderung.findFirst({
          where: {
            userId: session.user.id, entryId: null, withdrawnAt: null,
            AND: [inspectionTargetWhere(inspectionTarget, submissionDeviceId), subVisibleKontrolleWhere(fulfilmentAt)],
            createdAt: { lte: fulfilmentAt },
          },
          orderBy: { deadline: "asc" },
          select: { id: true },
        });
        if (nfcKontrolle) {
          await tx.kontrollAnforderung.update({
            where: { id: nfcKontrolle.id },
            data: { entryId: created.id, fulfilledAt: fulfilmentAt },
          });
        }
      }
      requiredAnforderungDeviceIds = awaitsBolt ? [] : await applyEntryFulfilment(
        tx,
        created,
        {
          verification: kontrolleAirlockValidated ? null : verification,
          targetWhere: inspectionTarget ? inspectionTargetWhere(inspectionTarget, submissionDeviceId) : null,
          // Ob es verlangt wird, sagt die Anforderung; ob es fehlt, weiss nur der Body.
          boxPhotoMissing: !boxImageUrl,
        },
        fulfilmentAt,
      );

      // Fork — Belohnungs-Fenster eingelöst → Kontoauszug-Eintrag (das Guthaben wurde beim Gewähren
      // abgebucht, delta 0). Liest die Anforderung, die `applyEntryFulfilment` soeben mit DIESEM
      // Eintrag erfüllt hat — keine zweite Zuordnungs-Regel daneben.
      if (type === "ORGASMUS") {
        const redeemed = await tx.orgasmusAnforderung.findFirst({
          where: { entryId: created.id, istBelohnung: true },
          select: { user: { select: { verdienteOrgasmen: true } } },
        });
        if (redeemed) {
          await tx.belohnungEvent.create({
            data: {
              userId: session.user.id, type: "EINGELOEST", delta: 0,
              balanceAfter: redeemed.user.verdienteOrgasmen, detail: "Belohnung eingelöst",
            },
          });
        }
      }

      // Fork — Trage-Anforderung (Plug & Co.) erfüllen: ein WEAR_BEGIN auf die Kategorie erfüllt die
      // älteste offene, bereits ausgelöste Anforderung dieser Kategorie. KG-Anforderungen
      // (deviceCategoryId null) erfüllt der VERSCHLUSS über `applyEntryFulfilment`.
      if (type === "WEAR_BEGIN" && wearCategoryId) {
        const wearAnf = await tx.verschlussAnforderung.findFirst({
          where: {
            userId: session.user.id,
            art: "ANFORDERUNG",
            deviceCategoryId: wearCategoryId,
            fulfilledAt: null,
            withdrawnAt: null,
            createdAt: { lte: fulfilmentAt },
            ...triggeredWhere(fulfilmentAt),
          },
          orderBy: { createdAt: "asc" },
          select: { id: true },
        });
        if (wearAnf) {
          await tx.verschlussAnforderung.update({ where: { id: wearAnf.id }, data: { fulfilledAt: fulfilmentAt } });
        }
        // WEAR_DEVICE-Task (KI-Keyholderin) erfüllen: WEAR_BEGIN schliesst einen offenen Trage-Task ab.
        const openTask = await tx.keyholderTask.findFirst({
          where: { userId: session.user.id, type: "WEAR_DEVICE", completedAt: null },
          orderBy: { assignedAt: "asc" },
          select: { id: true },
        });
        if (openTask) {
          await tx.keyholderTask.update({ where: { id: openTask.id }, data: { completedAt: fulfilmentAt } });
        }
      }

      // Fork — SessionAnforderung erfüllen, wenn SESSION_END erfasst wird — aber nur, wenn die
      // Mindestdauer erreicht, ggf. Video vorhanden und (falls gesetzt) das richtige Gerät genutzt ist.
      if (type === "SESSION_END" && sessionCategoryId) {
        const offeneSessionAnf = await getActiveSessionAnforderung(session.user.id, sessionCategoryId, tx);
        if (offeneSessionAnf) {
          const durMin = sessionBeginTime
            ? (effectiveStart.getTime() - sessionBeginTime.getTime()) / 60000
            : 0;
          const minOk = !offeneSessionAnf.minMinuten || durMin >= offeneSessionAnf.minMinuten;
          const videoOk = !offeneSessionAnf.requireVideo || !!videoUrl;
          const deviceOk = !offeneSessionAnf.deviceId || offeneSessionAnf.deviceId === deviceId;
          if (minOk && videoOk && deviceOk) {
            await fulfillSessionAnforderung(offeneSessionAnf.id, created.id, tx);
          }
        }
      }

      // Box-Kopplung: die Heimdall-Box folgt dem Eintrag. Die Regel — samt der zwei Fälle, in denen
      // sie ihm NICHT folgt — steht in `boxCommandForEntry`. No-op ohne Heimdall/Box.
      const cmd = boxCommandForEntry({ type, keyInBox: keyInBoxDeclared, brokeLockPeriod: withdrawnLockPeriod });
      // Angesagt wird nur, was wirklich gesetzt wurde — ohne Box bleibt `boxCmd` leer.
      if (cmd && await setBoxCommandForUser(tx, session.user.id, cmd)) boxCmd = cmd;

      return created;
      // Fork — Timeout hochgesetzt: die Transaktion ist reine DB-Arbeit (Sekundenbruchteile), kann
      // aber unter Schreib-Sperr-Contention mit dem Cron-Prozess auf die WAL-Sperre warten. 5 s
      // (Default) war zu knapp → vereinzelte "Transaction already closed"-Fehler beim Speichern.
    }, { timeout: 15000, maxWait: 10000 });
  } catch (e: unknown) {
    // Zwei gleiche Versuche GLEICHZEITIG: die Vorabprüfung oben sieht beide leer, beide schreiben,
    // der zweite läuft in den Index. Real, seit der Client abbricht — die erste Anfrage läuft
    // serverseitig weiter, während die Warteschlange dieselbe schon nachschickt.
    //
    // Ohne diesen Zweig käme ein P2002 im generischen `entryGuardCode(e)` an, das für ihn
    // `undefined` liefert: eine 400-Antwort mit leerem Fehlerfeld für einen Eintrag, der in
    // Wahrheit angelegt wurde.
    if (requestKey && isUniqueConstraintOn(e, "clientRequestId")) {
      const schonDa = await prisma.entry.findFirst({ where: { clientRequestId: requestKey, userId: session.user.id } });
      if (schonDa) return NextResponse.json(schonDa);
    }
    const code = entryGuardCode(e);
    // Fork: REGION_CONFLICT trägt zusätzlich die blockierende Kategorie — der stabile Code allein
    // kann sie nicht transportieren, die UI kann den Namen aber anzeigen.
    const blocking = code === "REGION_CONFLICT" ? ((e as { _blocking?: string })?._blocking ?? null) : undefined;
    return NextResponse.json(
      blocking === undefined ? { error: code } : { error: code, blocking },
      { status: GUARD_STATUS[code] ?? 400 },
    );
  }

  // Das Kommando ansagen (Heimdall-Instant-Push bzw. LockMeBox-Mitteilung ans Handy) — der
  // pendingCommand-Pull (in der Transaktion oben gesetzt) bleibt der Fallback. Dieselbe Entscheidung,
  // nicht dieselbe Bedingung noch einmal: sonst driften Pull und Push auseinander.
  if (boxCmd) announceBoxCommand(session.user.id, boxCmd);

  // Fork — Airlock-NFC: das per Tag validierte Lock beim Verschluss auf `active` setzen (Airlock-
  // Registry + lokaler Spiegel) — best-effort, blockiert die Antwort nicht (wie announceBoxCommand).
  if (type === "VERSCHLUSS" && airlockProof) void activateAirlockLock(airlockProof.code, session.user.id);
  // Fork — Airlock-NFC: beim Ablegen (OEFFNEN) das Einweg-Lock töten (retired). Best-effort; ist der
  // Server nicht erreichbar, bleibt es lokal „retired" und der nächste Sync zieht den Wechsel nach.
  if (type === "OEFFNEN" && airlockToRetire) void retireLock(airlockToRetire);

  // REINIGUNG-Limit wird NICHT mehr automatisch bestraft: eine Reinigungsöffnung über dem
  // Tageskontingent (auch ein Geräte-Wechsel) wird im Strafbuch nur noch ERKANNT (live in
  // buildStrafbuch abgeleitet); ob sie geahndet wird, entscheidet die Keyholderin. Das
  // Öffnen-Formular warnt weiterhin vorab — forcedReinigung bleibt rein informativ.
  //
  // Fork: dasselbe gilt für eine während einer Pause gemeldete Erektion (`erektionGemeldet`) — sie
  // wird im Strafbuch nur ERKANNT; ob sie geahndet wird, entscheidet die Keyholderin.

  // Was einem wirksamen Eintrag FOLGT: automatische Ahndung eines falschen Geräts, Aktivitäts-
  // Stempel, die Kontrolle nach einer Reinigungspause („zeig mir, dass du wieder drin bist") und
  // die Meldung an die Keyholder in DEREN Sprache (Issue #43). Die vier Schritte stehen in
  // `applyEntryAftermath` (entryFulfilment.ts), weil der VERZÖGERTE Vollzug (`commitPendingLock`)
  // exakt dieselben braucht — und ein fünfter sonst an einer der beiden Stellen fehlte.
  //
  // `awaitsBolt` schaltet genau die zwei Schritte ab, die eine vollzogene Tat behaupten: wieder DRIN
  // ist der Träger erst mit dem Riegel, und „hat sich eingeschlossen" wäre bis dahin eine Behauptung
  // über etwas, das noch nicht passiert ist. Beides holt der Vollzug nach.
  await applyEntryAftermath(entry, {
    requiredDeviceIds: requiredAnforderungDeviceIds,
    endsCleaningPause: endsCleaningPause && !awaitsBolt,
    awaitsBolt,
    notify: awaitsBolt ? null : {
      actorUserId: session.user.id,
      userId: session.user.id,
      username: session.user.name ?? "User",
      type,
      startTime: effectiveStart,
      withdrawnLockPeriod,
      cleaningBlock,
      oeffnenGrund,
      orgasmusArt,
      kontrollCode,
      note,
      imageUrl,
      keyInBoxDeclared,
      lockStartTime,
      deviceId,
      pauseDevice: type === "PAUSE_BEGIN" || type === "PAUSE_END" ? (pauseDevice || null) : null,
      reasonConfig: reasonUser,
    },
  });

  // Kontroll-Geräte-Check (advisory): ist das erwartete Gerät im Kontroll-Foto sichtbar? Welches das
  // ist, steht schon fest — die Ziel-Auflösung in der Transaktion hat es bestimmt, dieselbe Quelle
  // wie für die Code-Prüfung. Server-seitig + fire-and-forget (blockiert die Antwort NICHT);
  // Ergebnis landet als entry.deviceCheck, das der Keyholder sieht. Der Vorgang (inkl. der Pflicht,
  // das oben gesetzte "pending" IMMER durch einen Endzustand zu ersetzen) liegt in
  // deviceCheckService — hier steht nur der Start.
  if (deviceCheckApplies(type, imageUrl)) {
    void runDeviceCheck({
      entryId: entry.id,
      userId: session.user.id,
      photoUrl: imageUrl!,
      expectedDeviceId: inspectionExpectedDeviceId,
    });
  }

  // Bildersafe-Codewechsel (#115): derselbe Vorgang wie im Formular „Code versiegeln", hier für das
  // Code-Foto, das direkt mit dem Verschluss kam. Ersetzt das oben gesetzte "pending" und meldet
  // `same`/`uncertain` der Keyholderin (lockboxCodeCheckService).
  if (codeCheckRuns) {
    void runCodeChangeCheck({ entryId: entry.id, userId: session.user.id, codeImageUrl, startTime: entry.startTime });
  }

  // Foto-Verifikation (Code bzw. nur Siegel) — der Vorgang inkl. der Pflicht, das oben gesetzte
  // "pending" durch einen Endzustand zu ersetzen, liegt in inspectionVerificationService. Hier steht
  // nur der Start, und `verification` ist derselbe Wert, der oben den Startwert bestimmt hat.
  // Fork: bei einer Airlock-Kontrolle ersetzt der Tag-Scan die Foto-Prüfung — der Status steht
  // bereits auf „verified" und darf nicht von einer Code-Lesung im Foto überschrieben werden.
  if (verification && imageUrl && !kontrolleAirlockValidated) {
    void runInspectionVerification({
      entryId: entry.id,
      userId: session.user.id,
      photoUrl: imageUrl,
      // Die Foto-Drehung des Nutzers respektieren — sonst scheitert die Server-Prüfung an einem
      // gedrehten Bild, das in der Client-Vorschau gematcht hat.
      rotation: parseRotation(imageRotation),
      verification,
    });
  }

  // Schlüssel-Erkennung auf dem Box-Foto — server-seitig und fire-and-forget (`boxPhotoDueService.ts`).
  // Beim VERSCHLUSS kommt das Foto nicht mehr mit: es wird erst nach „Riegel zu" nachgereicht.
  if (BOX_PHOTO_TYPES.has(type) && boxImageUrl) detectKeyInBoxInBackground(entry.id, boxImageUrl, boxImageRotation);

  // Meldet die Box den Riegel schon JETZT zu, wartet der Verschluss auf nichts (`lockAwaitsBolt`) und
  // es käme keine neue Meldung mehr — das Foto muss hier fällig werden, nicht erst beim nächsten Sync.
  if (type === "VERSCHLUSS" && !awaitsBolt && keyInBoxDeclared === true) await markBoxPhotoDueIfBoxLocked(session.user.id);

  if (type === "VERSCHLUSS" || type === "OEFFNEN") {
    revalidatePath("/dashboard", "layout");
  }

  // Fork — Fire-and-forget: die KI-Keyholderin reagiert auf den neuen Eintrag (Chat-Nachricht; Push
  // nur bei KG-Typen). WEAR_BEGIN/END bleiben aussen vor (Spam); Pausen sind für sie relevant. Ein
  // schwebender Aufruf (Riegel) ist noch keine Tat — wie die Keyholder-Meldung oben nicht jetzt.
  if (!awaitsBolt && ["VERSCHLUSS", "OEFFNEN", "PRUEFUNG", "ORGASMUS", "PAUSE_BEGIN", "PAUSE_END"].includes(type)) {
    reactToSubEvent(session.user.id, session.user.name ?? session.user.id, type, note ?? null, imageUrl ?? null).catch(() => {});
  }

  // Fork — Fire-and-forget: erreicht dieser Eintrag ein Trainingsziel, entsteht das Belohnungs-
  // Guthaben automatisch — die Keyholderin muss es danach nur noch gewähren. Nur trage-abschliessende
  // Typen (OEFFNEN/WEAR_END) erhöhen die kumulierte Tragezeit.
  if (!awaitsBolt && (type === "OEFFNEN" || type === "WEAR_END")) {
    autoGrantReachedGoals(session.user.id).catch(() => {});
  }

  return NextResponse.json(entry, { status: 201 });
}
