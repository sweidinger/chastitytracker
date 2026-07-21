import { prisma } from "@/lib/prisma";
import { sendMailSafe, escHtml, appBaseUrl, noticeBoxHtml, dashboardEmailHtml } from "@/lib/mail";
import { formatDateTime } from "@/lib/utils";
import { firePush } from "@/lib/push";
import { markLastAction } from "@/lib/appMeta";
import { notifyUser, type NotifyContent } from "@/lib/notify";
import { emailT, emailGreeting } from "@/lib/emailI18n";
import { toLocale, inspectionHelpUrl, EMAIL_BUTTON_COLORS } from "@/lib/constants";
import { computeDelayedTrigger, isHiddenFromSub } from "@/lib/delayedTrigger";
import { serviceErrors, mapServiceError, serviceFail, type ServiceResult } from "@/lib/serviceResult";
import { getLatestKgEntry, type PrismaTx } from "@/lib/queries";
import { plugCategoryId } from "@/lib/deviceCategories";

export type KontrolleAction = "withdraw" | "manuallyVerify" | "reject";

/** Der resultierende Entry.verifikationStatus einer Verify/Reject-Aktion — EINE Stelle, geteilt vom
 *  echten Commit (unten) und vom MCP resolve_inspection dryRun-Preview (B-05), damit beide nie
 *  auseinanderlaufen können. */
export function verifikationStatusFor(action: "manuallyVerify" | "reject"): "manual" | "rejected" {
  return action === "manuallyVerify" ? "manual" : "rejected";
}

/**
 * Resolves an inspection by id: withdraw it, or manually verify / reject its submitted photo.
 * Shared by PATCH /api/admin/kontrollen/[id] and the MCP resolve_inspection tool.
 */
export async function resolveKontrolle(id: string, action: KontrolleAction): Promise<ServiceResult<{ userId: string; notified: boolean }>> {
  const ka = await prisma.kontrollAnforderung.findUnique({ where: { id } });
  if (!ka) return serviceFail(404, "INSPECTION_NOT_FOUND");

  if (action === "withdraw") {
    if (ka.withdrawnAt) return serviceFail(400, "INSPECTION_ALREADY_WITHDRAWN");
    await prisma.kontrollAnforderung.update({ where: { id }, data: { withdrawnAt: new Date() } });
    markLastAction();
  } else if (action === "manuallyVerify" || action === "reject") {
    if (!ka.entryId) return serviceFail(400, "INSPECTION_NO_SUBMISSION");
    await prisma.entry.update({ where: { id: ka.entryId }, data: { verifikationStatus: verifikationStatusFor(action) } });
    markLastAction();
  } else {
    return serviceFail(400, "UNKNOWN_ACTION");
  }

  // Eine noch nicht ausgeloeste Kontrolle ist fuer den Sub unsichtbar (`wirksamAb` in der Zukunft) —
  // ihren Rueckzug zu melden verriete sie. Bei Auto-Kontrollen waere es der Zufallsplan, dessen
  // Ueberraschung der Sinn ist. Nur `withdraw` kann das treffen: `manuallyVerify`/`reject` setzen ein
  // eingereichtes Foto voraus, die Kontrolle hat also laengst ausgeloest.
  const notified = action !== "withdraw" || !isHiddenFromSub(ka);
  if (notified) {
    const notif: NotifyContent =
      action === "manuallyVerify" ? { subjectKey: "inspectionConfirmedSubject", messageKey: "inspectionConfirmedMessage" }
      : action === "reject" ? { subjectKey: "inspectionRejectedSubject", messageKey: "inspectionRejectedMessage" }
      : { subjectKey: "inspectionResolvedWithdrawnSubject", messageKey: "inspectionResolvedWithdrawnMessage" };
    await notifyUser(ka.userId, notif);
  }

  return { ok: true, data: { userId: ka.userId, notified } };
}

/** Gültige Siegel-Nummer aus dem letzten Eintrag (5–8-stellig, nur bei aktivem VERSCHLUSS), sonst null.
 *  Single source für „ist dieser Code eine Siegel-Nummer" — genutzt beim Anlegen und im Poller. */
export function deriveSealCode(latest: { type: string; kontrollCode: string | null } | null): string | null {
  return latest?.type === "VERSCHLUSS" && latest.kontrollCode && /^\d{5,8}$/.test(latest.kontrollCode)
    ? latest.kontrollCode
    : null;
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
  if (!userId) return serviceFail(400, "USER_ID_REQUIRED");

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return serviceFail(404, "USER_NOT_FOUND");
  if (!user.email) return serviceFail(400, "USER_NO_EMAIL");

  const kommentarTrimmed = typeof kommentar === "string" ? kommentar.trim() : null;
  const hours = typeof deadlineH === "number" && deadlineH > 0 ? deadlineH : 4;
  const now = new Date();
  const { wirksamAb, benachrichtigtAt } = computeDelayedTrigger(now, { delayMinutes });
  // Frist läuft ab Auslösung (bei sofort = jetzt, bei geplant = wirksamAb).
  const deadline = new Date((wirksamAb ?? now).getTime() + hours * 60 * 60 * 1000);

  let code: string | null;
  let sealCode: string | null;
  // Wurf- und Fang-Seite hängen an derselben Tabelle: `fail()` akzeptiert nur Codes, die unten
  // auch gemappt werden — ein Tippfehler ist ein Compile-Fehler, kein stiller 500.
  const { table: ERRORS, fail } = serviceErrors({
    NOT_LOCKED: { status: 400, error: "USER_NOT_LOCKED" },
    ALREADY_ACTIVE: { status: 409, error: "INSPECTION_ALREADY_ACTIVE" },
    NOT_WEARING: { status: 400, error: "PLUG_NOT_WORN" },
  });
  try {
    const result = await prisma.$transaction(async (tx) => {
      // Geraet (default CAGE / Legacy). Voraussetzung geraetespezifisch:
      // CAGE -> muss verschlossen sein; PLUG -> muss getragen werden (aktive Plug-Session).
      const dev: "CAGE" | "PLUG" = device === "PLUG" ? "PLUG" : "CAGE";
      let sealSource: Awaited<ReturnType<typeof getLatestKgEntry>> | null = null;
      if (dev === "CAGE") {
        const latest = await getLatestKgEntry(userId, tx);
        if (!latest || latest.type !== "VERSCHLUSS") throw fail("NOT_LOCKED");
        sealSource = latest;
      } else {
        const latestPlug = await tx.entry.findFirst({
          where: { userId, type: { in: ["WEAR_BEGIN", "WEAR_END"] }, device: { categoryId: plugCategoryId(userId) } },
          orderBy: { startTime: "desc" },
          select: { type: true },
        });
        if (!latestPlug || latestPlug.type !== "WEAR_BEGIN") throw fail("NOT_WEARING");
      }

      // Ueberschneidungs-Schutz (geraete-bewusst): eine laufende Kontrolle DESSELBEN Geraets blockiert
      // eine neue — Cage und Plug duerfen weiterhin parallel kontrolliert werden. Ablehnen statt eine
      // laufende stillschweigend zu ersetzen, egal ob sie von Keyholder, KI oder Auto-Kontrolle stammt.
      // Der Check laeuft in derselben Transaktion wie das Anlegen; das deckt den Alltag ab. Es ist ein
      // Best-Effort-Read-then-Write, KEIN harter Ausschluss: bei exakt gleichzeitigen Anfragen koennen
      // unter SQLite-Snapshot-Isolation beide "keine laufende" lesen und je eine Zeile anlegen. Bei
      // zwei Schreibern (Keyholder + KI) ist das vernachlaessigbar, und die Folge waeren nur zwei
      // transiente Zeilen, von denen eine ohnehin ablaeuft — ein DB-Constraint kann "aktiv innerhalb
      // der Frist" (now-abhaengig) nicht ausdruecken, daher bewusst kein Index.
      if (await hasActiveKontrolle(userId, now, { tx, device: dev })) {
        throw fail("ALREADY_ACTIVE");
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
          benachrichtigtAt, // sofort = jetzt benachrichtigt; geplant = Poller
        },
      });

      return { code: c, sealCode: seal };
    });
    code = result.code;
    sealCode = result.sealCode;
  } catch (e: unknown) {
    const mapped = mapServiceError(e, ERRORS);
    if (mapped) return mapped;
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
  const kommentarHtml = kommentar ? noticeBoxHtml(t("inspectionAdminLabel"), kommentar) : "";

  const kommentarParam = kommentar ? `&kommentar=${encodeURIComponent(kommentar)}` : "";
  const baseUrl = appBaseUrl();
  const helpUrl = inspectionHelpUrl(locale);
  const deadlineStr = formatDateTime(deadline);

  // Fork: ohne Frische-Code (requireCode=false) genuegt das Foto als Trage-Nachweis.
  const photoOnly = code === null;
  const sealRequired = !photoOnly && requiredSealCode(code, sealCode) !== null;
  const link = photoOnly
    ? `${baseUrl}/dashboard/new/pruefung${kommentarParam ? `?${kommentarParam.slice(1)}` : ""}`
    : `${baseUrl}/dashboard/new/pruefung?code=${code}${kommentarParam}`;

  const codeBlockHtml = photoOnly
    ? ""
    : `<p><strong>${sealCode && !sealRequired ? t("inspectionCodeLabelSeal") : t("inspectionCodeLabelControl")}</strong></p>
      <div style="font-size:48px;font-weight:bold;letter-spacing:12px;color:#f97316;text-align:center;padding:24px;background:#fff7ed;border-radius:12px;margin:16px 0">${code}</div>`;

  const sealHintNeeded = photoOnly ? !!sealCode : sealRequired;
  const sealHintHtml = sealHintNeeded
    ? `<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:14px 18px;margin:16px 0"><p style="margin:0;font-size:14px;color:#1e3a8a"><strong>${photoOnly ? t("inspectionSealHintLabelPhoto") : t("inspectionSealHintLabel")}</strong> ${photoOnly ? t("inspectionSealHintTextPhoto") : t("inspectionSealHintText")}</p></div>`
    : "";

  await sendMailSafe(
    user.email,
    `KG-Tracker – ${t("inspectionRequestedSubject")}`,
    dashboardEmailHtml(
      t("inspectionRequestedSubject"),
      `${emailGreeting(t, user.username)}
      <p>${escHtml(photoOnly ? t("inspectionRequestedIntroPhoto", { hours: hoursLeft }) : t("inspectionRequestedIntro", { hours: hoursLeft }))}</p>
      ${kommentarHtml}
      ${codeBlockHtml}
      ${sealHintHtml}
      <p><strong>${t("inspectionDeadlineLabel")}</strong> ${deadlineStr}</p>`,
      t("inspectionButton"),
      {
        buttonColor: EMAIL_BUTTON_COLORS.inspection,
        buttonHref: link,
        // Link-Fallback + Hilfe-Footer stehen NACH dem Button — dafuer gibt es den afterHtml-Slot.
        afterHtml:
          `<p style="color:#94a3b8;font-size:12px">${escHtml(t("inspectionLinkFallback", { link }))}</p>` +
          `<p style="color:#64748b;font-size:13px;margin-top:20px;border-top:1px solid #f1f5f9;padding-top:16px">${escHtml(t("inspectionHelpText"))} <a href="${helpUrl}" style="color:${EMAIL_BUTTON_COLORS.default}">${escHtml(t("inspectionHelpLink"))}</a></p>`,
      },
    ),
  );

  const pushParts = [
    photoOnly ? t("inspectionPushPhotoOnly") : t("inspectionPushCode", { code }),
    t("inspectionPushDeadline", { deadline: deadlineStr }),
  ];
  if (sealHintNeeded) pushParts.push(t("inspectionPushSeal"));
  if (kommentar) pushParts.push(kommentar);
  firePush(
    user.id,
    t("inspectionPushTitle"),
    pushParts.join(" · "),
    photoOnly ? `/dashboard/new/pruefung` : `/dashboard/new/pruefung?code=${code}`,
  );
}
