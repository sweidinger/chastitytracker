import "server-only";
import { prisma } from "@/lib/prisma";
import { listLocks, isLockAvailable, setStatus } from "./client";
import type { AirlockCallResult, AirlockOut } from "./types";

/** Airlock-Status, in denen ein Lock endgültig „tot" ist (nicht mehr verwendbar/zuweisbar). */
const DEAD_STATUSES = new Set(["retired", "voided"]);

/**
 * Airlock-NFC — Zuordnungs-/Sync-Logik zwischen der Airlock-Registry und dem KG-Tracker.
 *
 * Die Airlock-App kennt nur Codes/Status/UID, KEINE Nutzer:innen. Welche Person welches Lock trägt,
 * hält allein der KG-Tracker (Tabelle `AirlockLock`). Diese Schicht spiegelt den Airlock-Stand in die
 * lokale Tabelle und verwaltet die Zuweisung Lock ↔ Sub. Die Zuweisung ist rein tracker-intern und
 * ändert NICHT den Airlock-Status — auf `active` geht ein Lock erst beim tatsächlichen Verschluss
 * (Phase 3). So bleibt eine Zuweisung folgenlos zurücknehmbar. Siehe docs/AIRLOCK_NFC.md § 4.
 */

/** Ein Lock, angereichert um den lokalen Zuweisungs-Stand (für UI-Listen). */
export interface AirlockLockView {
  code: string;
  status: string | null;
  nfcUid: string | null;
  /** frei zuweisbar laut Airlock (getaggt + Status frei) */
  available: boolean;
  assignedUserId: string | null;
  assignedUsername: string | null;
  lastSyncedAt: string | null;
}

/**
 * Holt alle Locks aus der Airlock-Registry, spiegelt sie in `AirlockLock` (code, nfcUid, status,
 * lastSyncedAt) und gibt die zusammengeführte Sicht inkl. lokaler Zuweisung zurück. Gibt den Airlock-
 * Fehlerzustand 1:1 durch (nicht erreichbar / HTTP-Fehler), damit das UI das anzeigen kann.
 *
 * Locks, die die Airlock-Registry nicht (mehr) liefert, bleiben als lokale Zeile bestehen (z.B. weil
 * sie einem Sub zugewiesen sind) — sie werden nur nicht aktualisiert. So verschwindet eine aktive
 * Zuweisung nicht, nur weil ein Lock in der Registry temporär nicht gelistet ist.
 */
export async function syncAndListLocks(): Promise<AirlockCallResult<AirlockLockView[]>> {
  const res = await listLocks();
  if (!res.ok) return res;

  const now = new Date();
  // Lokale Zeilen vorab laden — für den Retire-Reconcile und den Schutz vor Status-Downgrade
  // (ein lokal getötetes Lock, dessen Retire-Push beim Ablegen scheiterte, darf der Sync NICHT
  // wieder auf den Server-Status „active" zurücksetzen).
  const existing = new Map((await prisma.airlockLock.findMany()).map((r) => [r.code, r]));

  // Spiegel aktualisieren (upsert je Code). Sequentiell gehalten — die Lock-Zahl ist klein (eine
  // Airlock-Instanz druckt überschaubar viele), und SQLite mag keine breiten Parallel-Schreibbursts.
  for (const lock of res.data) {
    const prev = existing.get(lock.code);
    const pendingRetire = !!prev?.retireRequestedAt && !DEAD_STATUSES.has(lock.status);
    if (pendingRetire) {
      // Retire wurde beim Ablegen angefordert, der Server ist aber noch nicht „retired" → nachziehen.
      const r = await setStatus(lock.code, "retired");
      await prisma.airlockLock.update({
        where: { code: lock.code },
        // Bei Erfolg bestätigt (Flag löschen); sonst lokal „retired" halten und beim nächsten Sync
        // erneut versuchen. In KEINEM Fall den Server-Status „active" übernehmen.
        data: r.ok
          ? { status: "retired", retireRequestedAt: null, lastSyncedAt: now }
          : { status: "retired", lastSyncedAt: now },
      });
      continue;
    }
    await prisma.airlockLock.upsert({
      where: { code: lock.code },
      create: {
        code: lock.code,
        nfcUid: lock.nfc_uid ?? null,
        status: lock.status ?? null,
        lastSyncedAt: now,
      },
      update: {
        nfcUid: lock.nfc_uid ?? null,
        status: lock.status ?? null,
        lastSyncedAt: now,
      },
    });
  }

  return { ok: true, data: await listLockViews(res.data) };
}

/** Baut die zusammengeführte Sicht aus den lokalen Zeilen + (optional) den frischen Airlock-Daten. */
async function listLockViews(fresh: AirlockOut[]): Promise<AirlockLockView[]> {
  const rows = await prisma.airlockLock.findMany({
    include: { assignedUser: { select: { username: true } } },
    orderBy: { code: "asc" },
  });
  const freshByCode = new Map(fresh.map((l) => [l.code, l]));

  return rows.map((row) => {
    const f = freshByCode.get(row.code);
    // „available" aus den frischen Airlock-Daten ableiten, wenn vorhanden; sonst aus dem lokalen
    // Spiegel (Airlock-Status frei + Tag gebunden) UND nicht lokal zugewiesen.
    const availableFromAirlock = f ? isLockAvailable(f) : freeFromMirror(row.status, row.nfcUid);
    return {
      code: row.code,
      status: row.status,
      nfcUid: row.nfcUid,
      available: availableFromAirlock && !row.assignedUserId,
      assignedUserId: row.assignedUserId,
      assignedUsername: row.assignedUser?.username ?? null,
      lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
    };
  });
}

function freeFromMirror(status: string | null, nfcUid: string | null): boolean {
  if (!nfcUid) return false;
  return status !== "active" && status !== "retired" && status !== "voided";
}

/**
 * Weist einem Sub ein Lock zu. Ein Sub kann MEHRERE Locks zugewiesen haben (Pool) — die Keyholderin/
 * der Admin gibt beim Verschluss-Anfordern eines davon vor, oder der Sub wählt beim eigenständigen
 * Verschluss selbst. Es wird daher KEINE vorherige Zuweisung mehr automatisch freigegeben. Wirft, wenn
 * der Code lokal unbekannt ist (erst syncen), das Lock bereits einem ANDEREN Sub gehört, oder tot ist.
 */
export async function assignLock(code: string, userId: string): Promise<void> {
  const lock = await prisma.airlockLock.findUnique({ where: { code } });
  if (!lock) throw new Error("AIRLOCK_LOCK_NOT_FOUND");
  if (lock.assignedUserId && lock.assignedUserId !== userId) {
    throw new Error("AIRLOCK_LOCK_ASSIGNED_OTHER");
  }
  if ((lock.status && DEAD_STATUSES.has(lock.status)) || lock.retireRequestedAt) {
    // Ein getötetes Lock ist verbraucht und nie wieder zuweisbar.
    throw new Error("AIRLOCK_LOCK_NOT_FOUND");
  }

  await prisma.airlockLock.update({
    where: { code },
    data: { assignedUserId: userId, assignedAt: new Date(), releasedAt: null, verifiedAt: null },
  });
}

/**
 * Gibt ein Lock frei (Zuweisung aufheben). Idempotent. Ein Lock, das gerade in einem AKTIVEN Verschluss
 * des Subs steckt, ist eingefroren und kann nicht freigegeben werden (erst nach dem Ablegen) → wirft
 * `AIRLOCK_LOCK_ACTIVE`.
 */
export async function releaseLock(code: string): Promise<void> {
  const lock = await prisma.airlockLock.findUnique({ where: { code } });
  if (!lock || !lock.assignedUserId) return; // schon frei → idempotent
  const activeCode = await getActiveAirlockCode(lock.assignedUserId);
  if (activeCode === code) throw new Error("AIRLOCK_LOCK_ACTIVE");
  await prisma.airlockLock.update({
    where: { code },
    data: { assignedUserId: null, releasedAt: new Date() },
  });
}

/** Alle einem Sub zugewiesenen (nicht freigegebenen) Locks — der Pool, aus dem vorgegeben/gewählt wird. */
export async function getAssignedLocks(userId: string) {
  return prisma.airlockLock.findMany({
    where: { assignedUserId: userId, releasedAt: null },
    orderBy: { assignedAt: "asc" },
  });
}

/**
 * Der Code des Locks, das GERADE in einem aktiven Verschluss des Subs steckt (eingefroren), oder null.
 * Abgeleitet aus dem jüngsten VERSCHLUSS/OEFFNEN-Eintrag: ein VERSCHLUSS mit gebundenem Airlock-Code ist
 * aktiv, bis ein OEFFNEN/WEAR_END folgt. Dient dem Freeze (kein Freigeben/Ändern des aktiven Locks).
 */
export async function getActiveAirlockCode(userId: string): Promise<string | null> {
  // Airlock ist KG-spezifisch (Verschluss/Öffnen) — Plug-WEAR_END o.ä. bewusst ausgeklammert, damit
  // eine parallele Nicht-KG-Aktion einen aktiven KG-Airlock nicht fälschlich als beendet erscheinen lässt.
  const latest = await prisma.entry.findFirst({
    where: { userId, type: { in: ["VERSCHLUSS", "OEFFNEN"] } },
    orderBy: { startTime: "desc" },
    select: { type: true, airlockCode: true },
  });
  return latest?.type === "VERSCHLUSS" ? latest.airlockCode ?? null : null;
}

/**
 * „Tötet" ein Lock beim Ablegen (OEFFNEN/WEAR_END eines Airlock-Verschlusses): Statuswechsel auf
 * `retired` in der Airlock-Registry (Source of Truth) + lokal, Zuweisung endgültig gelöst → fällt aus
 * dem Pool, nie wieder verwendbar. Best-effort: wirft NIE (das Ablegen ist bereits gespeichert). Ist der
 * Airlock-Server nicht erreichbar, bleibt `retireRequestedAt` gesetzt und `syncAndListLocks` zieht den
 * Statuswechsel beim nächsten Abgleich nach.
 */
export async function retireLock(code: string): Promise<void> {
  const res = await setStatus(code, "retired");
  const now = new Date();
  try {
    await prisma.airlockLock.updateMany({
      where: { code },
      data: {
        // Physisch ist das Einweg-Lock aufgeschnitten = tot → lokal optimistisch „retired".
        status: "retired",
        assignedUserId: null,
        releasedAt: now,
        // Bei Erfolg bestätigt; sonst für den Reconcile beim nächsten Sync markieren.
        retireRequestedAt: res.ok ? null : now,
        ...(res.ok ? { lastSyncedAt: now } : {}),
      },
    });
  } catch {
    /* best-effort — Ablegen bleibt gültig, der Spiegel gleicht sich beim nächsten Sync ab */
  }
}

/**
 * Setzt ein Lock beim tatsächlichen Verschluss auf `active` — in der Airlock-Registry (Source of Truth)
 * UND im lokalen Spiegel — und bindet es an den Sub. Best-effort: wirft NIE (der Verschluss-Eintrag
 * ist bereits gespeichert; ein fehlgeschlagener Status-Push darf ihn nicht zurückrollen). `setStatus`
 * liefert selbst nur ein Result-Objekt (kein Throw); die DB-Updates sind defensiv gekapselt.
 * Ein Lock, das bereits einem ANDEREN Sub gehört, wird nicht übernommen.
 */
export async function activateAirlockLock(code: string, userId: string): Promise<void> {
  await setStatus(code, "active");
  try {
    const now = new Date();
    await prisma.airlockLock.updateMany({
      where: { code },
      data: { status: "active", lastSyncedAt: now },
    });
    await prisma.airlockLock.updateMany({
      where: { code, OR: [{ assignedUserId: null }, { assignedUserId: userId }] },
      data: { assignedUserId: userId, assignedAt: now, releasedAt: null },
    });
  } catch {
    /* best-effort — Verschluss bleibt gültig, Spiegel gleicht sich beim nächsten Sync ab */
  }
}

/** Markiert ein dem Sub zugewiesenes Lock als per Tag-Scan verifiziert (Sicherheits-Feature). */
export async function markLockVerified(code: string, userId: string): Promise<void> {
  await prisma.airlockLock.updateMany({
    where: { code, assignedUserId: userId },
    data: { verifiedAt: new Date() },
  });
}
