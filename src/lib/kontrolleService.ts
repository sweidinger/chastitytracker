import { prisma } from "@/lib/prisma";
import { sendMail, escHtml } from "@/lib/mail";
import { formatDateTime } from "@/lib/utils";
import { sendPushToUser } from "@/lib/push";
import { trackEvent } from "@/lib/telemetry";
import { notifyUser, type NotifyContent } from "@/lib/notify";
import { emailT, emailGreeting } from "@/lib/emailI18n";
import { toLocale, inspectionHelpUrl } from "@/lib/constants";
import type { ServiceResult } from "@/lib/serviceResult";
import type { PrismaTx } from "@/lib/queries";
import { plugCategoryId } from "@/lib/deviceCategories";

export type KontrolleAction = "withdraw" | "manuallyVerify" | "reject";

/**
 * Resolves an inspection by id: withdraw it, or manually verify / reject its submitted photo.
 * Shared by PATCH /api/admin/kontrollen/[id] and the MCP resolve_inspection tool.
 */
export async function resolveKontrolle(id: string, action: KontrolleAction): Promise<ServiceResult<{ userId: string }>> {
  const ka = await prisma.kontrollAnforderung.findUnique({ where: { id } });
  if (!ka) return { ok: false, status: 404, error: "Kontrolle nicht gefunden" };

  if (action === "withdraw") {
    if (ka.withdrawnAt) return { ok: false, status: 400, error: "Bereits zurückgezogen" };
    await prisma.kontrollAnforderung.update({ where: { id }, data: { withdrawnAt: new Date() } });
    trackEvent("kontrolle.withdrawn");
  } else if (action === "manuallyVerify" || action === "reject") {
    if (!ka.entryId) return { ok: false, status: 400, error: "Keine Einreichung vorhanden" };
    const verifikationStatus = action === "manuallyVerify" ? "manual" : "rejected";
    await prisma.entry.update({ where: { id: ka.entryId }, data: { verifikationStatus } });
    trackEvent(action === "manuallyVerify" ? "kontrolle.verified" : "kontrolle.rejected");
  } else {
    return { ok: false, status: 400, error: "Unbekannte Aktion" };
  }

  const notif: NotifyContent =
    action === "manuallyVerify" ? { subjectKey: "inspectionConfirmedSubject", messageKey: "inspectionConfirmedMessage" }
    : action === "reject" ? { subjectKey: "inspectionRejectedSubject", messageKey: "inspectionRejectedMessage" }
    : { subjectKey: "inspectionResolvedWithdrawnSubject", messageKey: "inspectionResolvedWithdrawnMessage" };
  await notifyUser(ka.userId, notif);

  return { ok: true, data: { userId: ka.userId } };
}

/** Gültige Siegel-Nummer aus dem letzten Eintrag (5–8-stellig, nur bei aktivem VERSCHLUSS), sonst null.
 *  Single source für „ist dieser Code eine Siegel-Nummer" — genutzt beim Anlegen und im Poller. */
export function deriveSealCode(latest: { type: string; kontrollCode: string | null } | null): string | null {
  return latest?.type === "VERSCHLUSS" && latest.kontrollCode && /^\d{5,8}$/.test(latest.kontrollCode)
    ? latest.kontrollCode
    : null;
}

/** Letzter KG-Entry (VERSCHLUSS/OEFFNEN) eines Users — Basis für Lock-Zustand + Siegel-Ableitung.
 *  Optionaler tx-Client für Transaktionen (Muster wie queries.ts). Single source der „letzter
 *  Lock-Entry"-Query, damit sie nicht über Route/Page/Poller driftet (Feed für deriveSealCode).
 *  `deviceId` wird mitgeladen (winziges Feld), damit auch der Geräte-Check im entries-POST dieselbe
 *  Query teilen kann statt eine eigene Kopie zu halten — deriveSealCode ignoriert es. */
export function getLatestKgEntry(userId: string, tx: PrismaTx | typeof prisma = prisma) {
  return tx.entry.findFirst({
    where: { userId, type: { in: ["VERSCHLUSS", "OEFFNEN"] } },
    orderBy: { startTime: "desc" },
    select: { type: true, kontrollCode: true, deviceId: true },
  });
}

/** Die Siegel-Nummer, die bei der Kontrolle ZUSÄTZLICH zum Kontroll-Code auf dem Foto lesbar sein
 *  muss — oder null. Legacy-Zeilen (Siegel == Code, aus der Zeit vor der Zufallscode-Umstellung)
 *  liefern null: der Code IST dort die Siegel-Nummer, keine Dual-Prüfung. Single source der
 *  „Siegel ≠ Code"-Regel für alle Aufrufer (Mail-Text, Formular-Hinweis). */
export function requiredSealCode(code: string, sealCode: string | null): string | null {
  return sealCode && sealCode !== code ? sealCode : null;
}

/** Verlangt eine Kontrolle mit diesem Code ZUSÄTZLICH die Siegel-Nummer im Foto? True, wenn ein
 *  aktives Siegel existiert, das vom Code abweicht. Bündelt die Kette (Lock-Entry → deriveSealCode →
 *  requiredSealCode) für Formular-Hinweis (Neuanlage + Edit) — eine Regel, eine Stelle. `latest` wird
 *  übergeben (kein interner Query), damit Aufrufer ihr bestehendes Fetch/Batch behalten. */
export function sealRequiredForCode(
  code: string | null | undefined,
  latest: { type: string; kontrollCode: string | null } | null,
): boolean {
  return !!code && requiredSealCode(code, deriveSealCode(latest)) !== null;
}

/** Frische 5-stellige Kontroll-Code-Nummer (10000–99999). */
export function generateKontrollCode(): string {
  return String(Math.floor(10000 + Math.random() * 90000));
}

/** True, wenn der User eine LAUFENDE Kontrolle hat — angelegt, nicht erfüllt, nicht zurückgezogen,
 *  bereits sichtbar (sofort oder wirksamAb erreicht) UND noch innerhalb der Frist (deadline >= now).
 *  Das entspricht genau Status "open" aus mapAnforderungStatus. Bewusst NICHT blockierend sind:
 *  - geplante (wirksamAb in Zukunft) — noch unsichtbar, es gibt nichts zu überschneiden;
 *  - überfällige (deadline < now) — das Fenster ist abgelaufen; eine solche Zeile würde sonst,
 *    wenn der Sub sie nie beantwortet und die Auto-Markierung aus ist, JEDE künftige (auch Auto-)
 *    Kontrolle dauerhaft blockieren. Überfällige werden weiter normal eskaliert/bestraft — sie
 *    zählen hier nur nicht mehr als "aktiv". Gemeinsamer Guard für requestKontrolle (Anlegen) UND
 *    den Poller (Ausliefern), damit sich echte laufende Kontrollen nie überschneiden.
 *  `excludeId` lässt den Poller "irgendeine ANDERE laufende" prüfen, wenn die zu prüfende Zeile
 *  selbst bereits auf die Kriterien passt. Kompatibel mit der Eskalations-Auto-Markierung: die
 *  setzt withdrawnAt, fällt also korrekt aus diesem Guard heraus, ohne Sonderfall-Code. */
export async function hasActiveKontrolle(
  userId: string,
  now: Date,
  opts?: { excludeId?: string; tx?: PrismaTx; device?: string | null },
): Promise<boolean> {
  const client = opts?.tx ?? prisma;
  const existing = await client.kontrollAnforderung.findFirst({
    where: {
      userId, entryId: null, withdrawnAt: null,
      OR: [{ wirksamAb: null }, { wirksamAb: { lte: now } }], // sichtbar
      deadline: { gte: now },                                 // noch innerhalb der Frist (nicht überfällig)
      ...(opts?.excludeId ? { id: { not: opts.excludeId } } : {}),
      // Geräte-bewusst: "CAGE" deckt auch Legacy-Zeilen ohne device ab; Plug-Kontrollen sind
      // davon unabhängig, damit Käfig und Plug parallel kontrolliert werden können.
      ...(opts?.device === undefined ? {} : opts.device === "PLUG"
        ? { device: "PLUG" }
        : { OR: [{ device: null }, { device: "CAGE" }] }),
    },
    select: { id: true },
  });
  return existing !== null;
}

export interface RequestKontrolleParams {
  userId: string;
  kommentar?: string | null;
  /** Deadline in hours (default 4). */
  deadlineH?: number | null;
  /** Verzögerte Auslösung in Minuten (>0). Fehlt/0 = sofort. Die 5–65-/Random-Policy
   *  liegt beim Aufrufer (MCP) — der Service verzögert nur mechanisch. */
  delayMinutes?: number | null;
  /**
   * true (default): frischer Zufallscode wird generiert, per E-Mail gesendet und muss im Foto
   * erkennbar sein (Frische-Beweis). false: kein Code — der User macht einfach ein Foto zum
   * Nachweis des Tragens; nur das Siegel (falls vorhanden) wird verifiziert.
   */
  requireCode?: boolean;
  /** Gerät, für das die Kontrolle gilt. "CAGE" | "PLUG" | null (null = KG, Legacy). */
  device?: "CAGE" | "PLUG" | null;
}

/**
 * Requests an inspection (KontrollAnforderung). If requireCode (default true), generates a fresh
 * random 5-digit code (freshness proof), sends it by e-mail and requires it in the photo. With
 * requireCode=false no code is generated — the user just submits a photo (seal still checked if
 * present). Sends e-mail + push immediately — or, with delayMinutes, schedules it (wirksamAb).
 * Shared by POST /api/admin/kontrolle and the MCP write tool. User must be currently locked.
 */
export async function requestKontrolle(
  params: RequestKontrolleParams,
): Promise<ServiceResult<{ code: string | null; deadline: string; scheduledFor: string | null }>> {
  const { userId, kommentar, deadlineH, delayMinutes, requireCode = true, device = null } = params;
  if (!userId) return { ok: false, status: 400, error: "userId fehlt" };

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return { ok: false, status: 404, error: "User nicht gefunden" };
  if (!user.email) return { ok: false, status: 400, error: "User hat keine E-Mail-Adresse" };

  const kommentarTrimmed = typeof kommentar === "string" ? kommentar.trim() : null;
  const hours = typeof deadlineH === "number" && deadlineH > 0 ? deadlineH : 4;
  const now = new Date();
  const wirksamAb =
    typeof delayMinutes === "number" && delayMinutes > 0
      ? new Date(now.getTime() + delayMinutes * 60 * 1000)
      : null;
  // Frist läuft ab Auslösung (bei sofort = jetzt, bei geplant = wirksamAb).
  const deadline = new Date((wirksamAb ?? now).getTime() + hours * 60 * 60 * 1000);

  let code: string | null;
  let sealCode: string | null;
  try {
    const result = await prisma.$transaction(async (tx) => {
      // Gerät (default CAGE / Legacy). Voraussetzung gerätespezifisch:
      // CAGE → muss verschlossen sein; PLUG → muss getragen werden (aktive Plug-Session).
      const dev: "CAGE" | "PLUG" = device === "PLUG" ? "PLUG" : "CAGE";
      let sealSource: Awaited<ReturnType<typeof getLatestKgEntry>> | null = null;
      if (dev === "CAGE") {
        const latest = await getLatestKgEntry(userId, tx);
        if (!latest || latest.type !== "VERSCHLUSS") {
          throw Object.assign(new Error(), { _code: "NOT_LOCKED" });
        }
        sealSource = latest;
      } else {
        const latestPlug = await tx.entry.findFirst({
          where: { userId, type: { in: ["WEAR_BEGIN", "WEAR_END"] }, device: { categoryId: plugCategoryId(userId) } },
          orderBy: { startTime: "desc" },
          select: { type: true },
        });
        if (!latestPlug || latestPlug.type !== "WEAR_BEGIN") {
          throw Object.assign(new Error(), { _code: "NOT_WEARING" });
        }
      }

        // Überschneidungs-Schutz (geräte-bewusst): eine laufende Kontrolle DESSELBEN Geräts blockiert
        // eine neue — Cage und Plug dürfen weiterhin parallel kontrolliert werden. Best-Effort-
        // Read-then-Write in derselben Transaktion (siehe hasActiveKontrolle).
        if (await hasActiveKontrolle(userId, now, { tx, device: dev })) {
          throw Object.assign(new Error(), { _code: "ALREADY_ACTIVE" });
        }

      // Code nur wenn requireCode=true. Siegel-Nummer nur bei CAGE (Plug hat kein Siegel).
      const seal = sealSource ? deriveSealCode(sealSource) : null;
      const c = requireCode ? generateKontrollCode() : null;

      await tx.kontrollAnforderung.create({
        data: {
          userId,
          code: c ?? "",          // leerer String wenn kein Code (Feld ist NOT NULL im Schema)
          deadline,
          kommentar: kommentarTrimmed || null,
          requireCode,
          device: dev,
          wirksamAb,
          benachrichtigtAt: wirksamAb ? null : now, // sofort = jetzt benachrichtigt; geplant = Poller
        },
      });

      return { code: c, sealCode: seal };
    });
    code = result.code;
    sealCode = result.sealCode;
  } catch (e: unknown) {
    if ((e as { _code?: string })?._code === "NOT_LOCKED") {
      return { ok: false, status: 400, error: "User ist nicht verschlossen" };
    }
    if ((e as { _code?: string })?._code === "NOT_WEARING") {
      return { ok: false, status: 400, error: "Plug wird nicht getragen" };
    }
    if ((e as { _code?: string })?._code === "ALREADY_ACTIVE") {
      return { ok: false, status: 409, error: "Es ist bereits eine Kontrolle aktiv – zuerst abschliessen oder zurückziehen." };
    }
    throw e;
  }

  // Sofort benachrichtigen; bei geplanter Auslösung übernimmt der Poller bei Fälligkeit.
  if (!wirksamAb) {
    await sendKontrolleNotification({ user, code, sealCode, kommentar: kommentarTrimmed, deadline });
  }

  return { ok: true, data: { code, deadline: deadline.toISOString(), scheduledFor: wirksamAb?.toISOString() ?? null } };

}

/**
 * Sends the inspection e-mail (code + deadline + link) and a push to the user.
 * Reused by the immediate path in requestKontrolle and by the delayed-trigger poller.
 * `sealCode` = aktive Siegel-Nummer (oder null): weicht sie vom Code ab, verlangt die Mail
 * zusätzlich das Siegel auf dem Foto; ist sie gleich dem Code (Legacy-Zeilen von vor der
 * Zufallscode-Umstellung), bleibt das alte „Siegel-Nummer"-Label.
 * No-op if the user has no e-mail. Push is fire-and-forget.
 */
export async function sendKontrolleNotification(opts: {
  user: { id: string; email: string | null; username: string; locale: string };
  code: string | null;  // null = kein Frische-Code erforderlich (nur Foto-Nachweis)
  sealCode: string | null;
  kommentar: string | null;
  deadline: Date;
}): Promise<void> {
  const { user, code, sealCode, kommentar, deadline } = opts;
  if (!user.email) return;

  const locale = toLocale(user.locale);
  const t = await emailT(locale);

  const hoursLeft = Math.max(1, Math.round((deadline.getTime() - Date.now()) / (60 * 60 * 1000)));
  const kommentarHtml = kommentar
    ? `<div style="background:#fefce8;border:1px solid #fde047;border-radius:10px;padding:14px 18px;margin:16px 0"><p style="margin:0 0 4px 0;font-size:13px;font-weight:bold;color:#713f12">${t("inspectionAdminLabel")}</p><p style="margin:0;font-size:15px;color:#422006">${escHtml(kommentar)}</p></div>`
    : "";

  const baseUrl = process.env.NEXTAUTH_URL ?? "http://localhost:3000";
  const kommentarParam = kommentar ? `&kommentar=${encodeURIComponent(kommentar)}` : "";
  const deadlineStr = formatDateTime(deadline);
  const helpUrl = inspectionHelpUrl(locale);

  let bodyHtml: string;
  let pushBody: string;
  let pushLink: string;

  if (code === null) {
    // Kein Frische-Code: nur Foto als Nachweis des Tragens
    const link = `${baseUrl}/dashboard/new/pruefung${kommentarParam ? `?${kommentarParam.slice(1)}` : ""}`;
    const sealHintHtml = sealCode
      ? `<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:14px 18px;margin:16px 0"><p style="margin:0;font-size:14px;color:#1e3a8a"><strong>${t("inspectionSealHintLabelPhoto")}</strong> ${t("inspectionSealHintTextPhoto")}</p></div>`
      : "";
    bodyHtml = `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
      <h2 style="color:#1e293b">${t("inspectionRequestedSubject")}</h2>
      ${emailGreeting(t, user.username)}
      <p>${escHtml(t("inspectionRequestedIntroPhoto", { hours: hoursLeft }))}</p>
      ${kommentarHtml}
      ${sealHintHtml}
      <p><strong>${t("inspectionDeadlineLabel")}</strong> ${deadlineStr}</p>
      <p>
        <a href="${link}" style="display:inline-block;background:#f97316;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:bold">
          ${t("inspectionButton")}
        </a>
      </p>
      <p style="color:#94a3b8;font-size:12px">${escHtml(t("inspectionLinkFallback", { link }))}</p>
      <p style="color:#64748b;font-size:13px;margin-top:20px;border-top:1px solid #f1f5f9;padding-top:16px">${escHtml(t("inspectionHelpText"))} <a href="${helpUrl}" style="color:#4f46e5">${escHtml(t("inspectionHelpLink"))}</a></p>
    </div>
    `;
    const pushParts = [t("inspectionPushPhotoOnly"), t("inspectionPushDeadline", { deadline: deadlineStr })];
    if (sealCode) pushParts.push(t("inspectionPushSeal"));
    if (kommentar) pushParts.push(kommentar);
    pushBody = pushParts.join(" · ");
    pushLink = `/dashboard/new/pruefung`;
  } else {
    // Mit Frische-Code: bestehende Logik
    const sealRequired = requiredSealCode(code, sealCode) !== null;
    const link = `${baseUrl}/dashboard/new/pruefung?code=${code}${kommentarParam}`;
    const codeLabel = sealCode && !sealRequired
      ? t("inspectionCodeLabelSeal")
      : t("inspectionCodeLabelControl");
    const sealHintHtml = sealRequired
      ? `<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:14px 18px;margin:16px 0"><p style="margin:0;font-size:14px;color:#1e3a8a"><strong>${t("inspectionSealHintLabel")}</strong> ${t("inspectionSealHintText")}</p></div>`
      : "";
    bodyHtml = `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
      <h2 style="color:#1e293b">${t("inspectionRequestedSubject")}</h2>
      ${emailGreeting(t, user.username)}
      <p>${escHtml(t("inspectionRequestedIntro", { hours: hoursLeft }))}</p>
      ${kommentarHtml}
      <p><strong>${codeLabel}</strong></p>
      <div style="font-size:48px;font-weight:bold;letter-spacing:12px;color:#f97316;text-align:center;padding:24px;background:#fff7ed;border-radius:12px;margin:16px 0">${code}</div>
      ${sealHintHtml}
      <p><strong>${t("inspectionDeadlineLabel")}</strong> ${deadlineStr}</p>
      <p>
        <a href="${link}" style="display:inline-block;background:#f97316;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:bold">
          ${t("inspectionButton")}
        </a>
      </p>
      <p style="color:#94a3b8;font-size:12px">${escHtml(t("inspectionLinkFallback", { link }))}</p>
      <p style="color:#64748b;font-size:13px;margin-top:20px;border-top:1px solid #f1f5f9;padding-top:16px">${escHtml(t("inspectionHelpText"))} <a href="${helpUrl}" style="color:#4f46e5">${escHtml(t("inspectionHelpLink"))}</a></p>
    </div>
    `;
    const pushParts = [t("inspectionPushCode", { code }), t("inspectionPushDeadline", { deadline: deadlineStr })];
    if (sealRequired) pushParts.push(t("inspectionPushSeal"));
    if (kommentar) pushParts.push(kommentar);
    pushBody = pushParts.join(" · ");
    pushLink = `/dashboard/new/pruefung?code=${code}`;
  }

  await sendMail(user.email, `KG-Tracker – ${t("inspectionRequestedSubject")}`, bodyHtml);

  sendPushToUser(user.id, t("inspectionPushTitle"), pushBody, pushLink)
    .catch(() => { /* ignore push errors */ });
}
