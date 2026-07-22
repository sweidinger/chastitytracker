import { prisma } from "@/lib/prisma";
import type { PrismaTx } from "@/lib/queries";
import { sendMailSafe, escHtml, noticeBoxHtml, dashboardEmailHtml } from "@/lib/mail";
import { formatDateTime } from "@/lib/utils";
import { firePush } from "@/lib/push";
import { ORGASMUS_ANFORDERUNG_ARTEN, toLocale, EMAIL_BUTTON_COLORS } from "@/lib/constants";
import { orgasmusValueAllowed, resolveOrgasmusArtDisplay, effectiveOrgasmusArten } from "@/lib/reasonsService";
import { notifyUser, type NotifyContent } from "@/lib/notify";
import { emailT, emailGreeting } from "@/lib/emailI18n";
import { getTranslations } from "next-intl/server";
import { serviceFail, type ServiceResult } from "@/lib/serviceResult";

/** `endetAt` in der Vergangenheit → Reject (B-01, MCP-Befundliste 2026-07-17): der einzige gefundene
 *  Pfad, auf dem der Tracker eine unverdiente Strafe erzeugt — mit `art:"ANWEISUNG"` wird ein bereits
 *  verstrichenes Fenster sofort zu einem `missed_orgasm`-Vergehen für eine Frist, die der Sub nie
 *  erfüllen konnte. `beginntAt` in der Vergangenheit bleibt zulässig (eine rückwirkend geöffnete
 *  Anforderung ist ein legitimer Fall) — nur das Ende muss in der Zukunft liegen. Analog zu
 *  {@link checkLockEnd} (verschlussAnforderungService.ts), das dieselbe Regel für Sperrzeiten zieht. */
export function checkOrgasmWindowEnd(endetAt: Date, now: Date): "ORGASM_END_MUST_BE_FUTURE" | null {
  return endetAt > now ? null : "ORGASM_END_MUST_BE_FUTURE";
}

export interface CreateOrgasmusAnforderungParams {
  userId: string;
  art: "ANWEISUNG" | "GELEGENHEIT";
  nachricht?: string | null;
  /** Window start (ISO string or Date). */
  beginntAt: string | Date;
  /** Window end (ISO string or Date). Must be after beginntAt. */
  endetAt: string | Date;
  /** Required orgasm type base (from ORGASMUS_ARTEN); null/undefined = any orgasm counts. */
  vorgegebeneArt?: string | null;
  /** Whether opening to perform the orgasm during the window is permitted (no Sperre break / penalty). */
  oeffnenErlaubt?: boolean;
  /** Als Strafe angeordnet (z.B. ruinierter Orgasmus als Pflicht) — strengere Eskalation bei Nicht-Erfüllung. */
  istStrafe?: boolean;
  /** Als Belohnungs-Fenster gewährt — kollidiert nicht mit einer offenen Anweisung/Gelegenheit (getrennter Withdraw-Scope). */
  istBelohnung?: boolean;
  /** Foto-Nachweis beim Erfassen des Orgasmus erforderlich. false = ein Foto ist freiwillig möglich. */
  fotoPflicht?: boolean;
}

/**
 * Creates an OrgasmusAnforderung (keyholder orgasm directive) for a user.
 * Single source of truth shared by POST /api/admin/orgasmus-anforderung and the MCP request_orgasm tool.
 * Withdraws an existing open directive (one active at a time) and notifies the user by e-mail + push —
 * identical behaviour whether triggered from the admin UI or the MCP.
 */
export async function createOrgasmusAnforderung(
  params: CreateOrgasmusAnforderungParams,
): Promise<ServiceResult<{ id: string }>> {
  const { userId, art, nachricht, beginntAt, endetAt, vorgegebeneArt, oeffnenErlaubt, istStrafe, istBelohnung, fotoPflicht } = params;

  if (!userId) return serviceFail(400, "USER_ID_REQUIRED");
  if (!(ORGASMUS_ANFORDERUNG_ARTEN as readonly string[]).includes(art)) {
    return serviceFail(400, "ORGASM_INVALID_ART");
  }
  if (!beginntAt || !endetAt) {
    return serviceFail(400, "ORGASM_WINDOW_REQUIRED");
  }
  const beginnt = new Date(beginntAt);
  const endet = new Date(endetAt);
  if (Number.isNaN(beginnt.getTime()) || Number.isNaN(endet.getTime())) {
    return serviceFail(400, "INVALID_DATETIME");
  }
  if (endet <= beginnt) {
    return serviceFail(400, "ORGASM_END_BEFORE_START");
  }
  const windowEndError = checkOrgasmWindowEnd(endet, new Date());
  if (windowEndError) return serviceFail(400, windowEndError);
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return serviceFail(404, "USER_NOT_FOUND");
  // vorgegebeneArt gegen die (ggf. angepasste) Orgasmus-Liste des Ziel-Subs prüfen; null-Config → Built-ins.
  if (vorgegebeneArt && !orgasmusValueAllowed(vorgegebeneArt, user.orgasmusArtenConfig)) {
    return serviceFail(400, "INVALID_ORGASM_TYPE");
  }

  // Withdraw existing open request + create the new one atomically (one active at a time).
  // Getrennter Scope: Belohnungs-Fenster (istBelohnung) und normale Anweisungen/Gelegenheiten
  // verdrängen sich NICHT gegenseitig — eine offene Strafe bleibt bestehen, wenn eine Belohnung
  // gewährt wird (und umgekehrt). Das Matching in /api/entries trennt sie über vorgegebeneArt.
  const belohnung = Boolean(istBelohnung);
  const anforderung = await prisma.$transaction(async (tx) => {
    await tx.orgasmusAnforderung.updateMany({
      where: { userId, fulfilledAt: null, withdrawnAt: null, istBelohnung: belohnung },
      data: { withdrawnAt: new Date() },
    });
    return tx.orgasmusAnforderung.create({
      data: {
        userId,
        art,
        nachricht: nachricht?.trim() || null,
        beginntAt: beginnt,
        endetAt: endet,
        vorgegebeneArt: vorgegebeneArt || null,
        oeffnenErlaubt: Boolean(oeffnenErlaubt),
        istStrafe: Boolean(istStrafe),
        istBelohnung: belohnung,
        fotoPflicht: Boolean(fotoPflicht),
      },
    });
  });

  await sendOrgasmusAnforderungNotifications({
    userId, user, art, nachricht, beginnt, endet, vorgegebeneArt, oeffnenErlaubt: Boolean(oeffnenErlaubt),
    fotoPflicht: Boolean(fotoPflicht),
  });

  return { ok: true, data: { id: anforderung.id } };
}

/** Notification text shown to the user when an open orgasm directive is withdrawn — shared by the
 *  per-userId (MCP) and per-id (admin route) withdraw paths so the text isn't duplicated. */
export function orgasmusWithdrawNotice(): NotifyContent {
  return { subjectKey: "orgasmWithdrawnSubject", messageKey: "orgasmWithdrawnMessage" };
}

/** Withdraws the user's currently open orgasm directive(s) (not yet fulfilled/withdrawn).
 *  Used by the MCP `withdraw` tool (userId-scoped — "neuste offene"). */
export async function withdrawOrgasmusAnforderung(userId: string): Promise<ServiceResult<{ count: number }>> {
  const now = new Date();
  // Aktive Belohnungs-Fenster (noch nicht abgelaufen), die durch DIESEN Rueckzug fallen: dafuer wird
  // das beim Gewaehren abgebuchte Guthaben erstattet. Bewusster Rueckzug != Ablauf (VERFALLEN behaelt
  // netto -1). Abgelaufene Fenster bleiben dem VERFALLEN-Pfad (getBelohnungState) ueberlassen.
  const offen = await prisma.orgasmusAnforderung.findMany({
    where: { userId, fulfilledAt: null, withdrawnAt: null },
    select: { istBelohnung: true, endetAt: true },
  });
  if (offen.length === 0) return { ok: true, data: { count: 0 } };
  const refund = offen.filter((o) => o.istBelohnung && o.endetAt >= now).length;
  const count = await prisma.$transaction(async (tx) => {
    const res = await tx.orgasmusAnforderung.updateMany({
      where: { userId, fulfilledAt: null, withdrawnAt: null },
      data: { withdrawnAt: now },
    });
    if (refund > 0) await refundReward(tx, userId, refund);
    return res.count;
  });
  if (count > 0) await notifyUser(userId, orgasmusWithdrawNotice());
  return { ok: true, data: { count } };
}

/** Erstattet `n` Belohnungs-Guthaben (User +n) und schreibt je ein ERSTATTET-Ereignis mit korrektem
 *  Zwischenstand. Bewusst hier mit `tx` statt via belohnung.ts, um den Import-Zyklus
 *  belohnung <-> orgasmusAnforderungService zu vermeiden (`logBelohnungEvent` haengt an belohnung). */
async function refundReward(tx: PrismaTx, userId: string, n: number): Promise<void> {
  const u = await tx.user.update({ where: { id: userId }, data: { verdienteOrgasmen: { increment: n } }, select: { verdienteOrgasmen: true } });
  let bal = u.verdienteOrgasmen - n;
  for (let i = 0; i < n; i++) {
    bal += 1;
    await tx.belohnungEvent.create({ data: { userId, type: "ERSTATTET", delta: 1, balanceAfter: bal, detail: "Belohnungs-Fenster zurueckgezogen — Guthaben erstattet" } });
  }
}

/** Withdraws a single OrgasmusAnforderung by id (not yet fulfilled/withdrawn). Used by the admin
 *  PATCH route — targets exactly one directive instead of all open ones. The route already looks
 *  up the row's `userId` for the auth guard, so it's passed in here to avoid a second fetch of the
 *  same row (single `updateMany` scoped by id + open-status does the existence/open check via
 *  `count`, matching the one-round-trip shape of `withdrawVerschlussAnforderung`). */
export async function withdrawOrgasmusAnforderungById(id: string, userId: string): Promise<ServiceResult<{ count: number }>> {
  const now = new Date();
  const row = await prisma.orgasmusAnforderung.findUnique({
    where: { id }, select: { istBelohnung: true, endetAt: true, fulfilledAt: true, withdrawnAt: true },
  });
  if (!row || row.fulfilledAt !== null || row.withdrawnAt !== null) {
    return serviceFail(400, "ORGASM_NOT_OPEN");
  }
  const refund = row.istBelohnung && row.endetAt >= now;
  await prisma.$transaction(async (tx) => {
    await tx.orgasmusAnforderung.update({ where: { id }, data: { withdrawnAt: now } });
    if (refund) await refundReward(tx, userId, 1);
  });
  await notifyUser(userId, orgasmusWithdrawNotice());
  return { ok: true, data: { count: 1 } };
}

/** Sends the directive e-mail + push to the user. Push is fire-and-forget. */
async function sendOrgasmusAnforderungNotifications(opts: {
  userId: string;
  user: { email: string | null; username: string; orgasmusArtenConfig: string | null; locale: string };
  art: "ANWEISUNG" | "GELEGENHEIT";
  nachricht?: string | null;
  beginnt: Date;
  endet: Date;
  vorgegebeneArt?: string | null;
  oeffnenErlaubt: boolean;
  fotoPflicht?: boolean;
}) {
  const { userId, user, art, nachricht, beginnt, endet, vorgegebeneArt, oeffnenErlaubt, fotoPflicht } = opts;
  const istAnweisung = art === "ANWEISUNG";
  const locale = toLocale(user.locale);
  const t = await emailT(locale);
  const betreff = istAnweisung ? t("orgasmAnweisungSubject") : t("orgasmGelegenheitSubject");
  const einleitung = istAnweisung ? t("orgasmAnweisungIntro") : t("orgasmGelegenheitIntro");
  const windowStr = `${formatDateTime(beginnt)} – ${formatDateTime(endet)}`;

  // Reason-Code → Anzeige-Label gegen die Config des Ziel-Subs auflösen (sonst zeigt eine Custom-Art
  // den rohen `c_…`-Code in Mail/Push). In der Sprache des Empfängers, wie der restliche Text.
  const tOrgasm = await getTranslations({ locale, namespace: "orgasmForm" });
  const artLabel = vorgegebeneArt
    ? resolveOrgasmusArtDisplay(vorgegebeneArt, effectiveOrgasmusArten(user.orgasmusArtenConfig), tOrgasm) ?? vorgegebeneArt
    : null;

  if (user.email) {
    const nachrichtHtml = nachricht?.trim() ? noticeBoxHtml(t("orgasmNoticeLabel"), nachricht.trim()) : "";
    const artHtml = artLabel ? `<p><strong>${t("orgasmArtLabel")}</strong> ${escHtml(artLabel)}</p>` : "";
    const oeffnenHtml = oeffnenErlaubt ? `<p><strong>${t("orgasmOpenAllowedLabel")}</strong> ${t("orgasmOpenAllowedText")}</p>` : "";
    const fotoHtml = fotoPflicht ? `<p><strong>${t("orgasmPhotoLabel")}</strong> ${t("orgasmPhotoText")}</p>` : "";
    await sendMailSafe(
      user.email,
      `KG-Tracker – ${betreff}`,
      dashboardEmailHtml(
        escHtml(betreff),
        `${emailGreeting(t, user.username)}
          <p>${escHtml(einleitung)}</p>
          ${nachrichtHtml}
          <p><strong>${t("orgasmWindowLabel")}</strong> ${windowStr}</p>
          ${artHtml}
          ${oeffnenHtml}
          ${fotoHtml}`,
        t("dashboardButton"),
        { buttonColor: EMAIL_BUTTON_COLORS.orgasm },
      ),
    );
  }

  const pushParts: string[] = [`${t("orgasmWindowLabel")} ${windowStr}`];
  if (artLabel) pushParts.push(artLabel);
  if (fotoPflicht) pushParts.push("Foto-Nachweis erforderlich");
  if (nachricht?.trim()) pushParts.push(nachricht.trim());
  firePush(userId, betreff, pushParts.join(" · "), "/dashboard");
}
