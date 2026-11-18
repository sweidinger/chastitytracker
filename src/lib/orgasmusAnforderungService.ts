import { prisma } from "@/lib/prisma";
import type { PrismaTx } from "@/lib/queries";
import { escHtml, optionalNoticeBoxHtml, dashboardEmailHtml } from "@/lib/mail";
import { formatDateTime } from "@/lib/utils";
import { ORGASMUS_ANFORDERUNG_ARTEN, toLocale, EMAIL_BUTTON_COLORS, APP_NAME } from "@/lib/constants";
import { orgasmusValueAllowed, resolveOrgasmusArtDisplay, effectiveOrgasmusArten } from "@/lib/reasonsService";
import { notifyUser, deliverToChannels, type NotifyContent, type NotifyRecipient } from "@/lib/notify";
import { computeDelayedTrigger, isHiddenFromSub, parseTriggerAt } from "@/lib/delayedTrigger";
import { recordInboxDelivery, type MessageActor } from "@/lib/messageService";
import { emailT, emailGreeting, localeT } from "@/lib/emailI18n";
import { serviceFail, type ServiceResult } from "@/lib/serviceResult";
import { isHealthHoldActive } from "@/lib/healthHold";

/** `endsAt` in der Vergangenheit → Reject (B-01, MCP-Befundliste 2026-07-17): der einzige gefundene
 *  Pfad, auf dem der Tracker eine unverdiente Strafe erzeugt — mit `art:"ANWEISUNG"` wird ein bereits
 *  verstrichenes Fenster sofort zu einem `missed_orgasm`-Vergehen für eine Frist, die der Sub nie
 *  erfüllen konnte. `beginsAt` in der Vergangenheit bleibt zulässig (eine rückwirkend geöffnete
 *  Anforderung ist ein legitimer Fall) — nur das Ende muss in der Zukunft liegen. Analog zu
 *  {@link checkLockEnd} (verschlussAnforderungService.ts), das dieselbe Regel für Sperrzeiten zieht. */
export function checkOrgasmWindowEnd(endsAt: Date, now: Date): "ORGASM_END_MUST_BE_FUTURE" | null {
  return endsAt > now ? null : "ORGASM_END_MUST_BE_FUTURE";
}

/** Das geprüfte Ergebnis: die drei Zeitpunkte, mit denen die Zeile geschrieben wird. */
export interface CheckedOrgasmWindow {
  beginsAtDate: Date;
  endsAtDate: Date;
  /** null = sofort auslösen (siehe {@link computeDelayedTrigger}). */
  wirksamAb: Date | null;
  benachrichtigtAt: Date | null;
}

/**
 * Alle Schranken der Anweisung, die OHNE Datenbank zu beantworten sind — prüfend und schreibfrei,
 * derselbe Schnitt wie `checkTask()` in `taskService.ts`.
 *
 * Genau deshalb ruft die MCP-dryRun-Vorschau sie auf, statt die Kette abzuschreiben: eine zweite
 * Nachrechnung läuft irgendwann auseinander und verspricht Erfolg für einen Commit, der mit 400
 * endet. **Eine neue Schranke gehört hierher**, nicht in die Vorschau.
 *
 * Was NICHT hier steht, weil es die DB braucht: `USER_NOT_FOUND` und die Prüfung der vorgegebenen
 * Art gegen die Liste des Ziel-Subs.
 */
export function checkOrgasmusAnforderung(
  p: CreateOrgasmusAnforderungParams,
  now: Date,
): { ok: true; window: CheckedOrgasmWindow } | { ok: false; code: "ORGASM_INVALID_ART" | "ORGASM_WINDOW_REQUIRED" | "ORGASM_INVALID_SEND_TIME" | "INVALID_DATETIME" | "ORGASM_END_BEFORE_START" | "ORGASM_END_MUST_BE_FUTURE" } {
  if (!(ORGASMUS_ANFORDERUNG_ARTEN as readonly string[]).includes(p.art)) {
    return { ok: false, code: "ORGASM_INVALID_ART" };
  }
  if (!p.beginsAt || !p.endsAt) return { ok: false, code: "ORGASM_WINDOW_REQUIRED" };
  const beginsAtDate = new Date(p.beginsAt);
  const endsAtDate = new Date(p.endsAt);
  if (Number.isNaN(beginsAtDate.getTime()) || Number.isNaN(endsAtDate.getTime())) {
    return { ok: false, code: "INVALID_DATETIME" };
  }
  if (endsAtDate <= beginsAtDate) return { ok: false, code: "ORGASM_END_BEFORE_START" };
  // Der Versandzeitpunkt bekommt einen EIGENEN Code, wie bei Verschluss und Aufgabe: sonst ist ein
  // vertipptes `scheduledAt` von einem vertippten Fenster-Datum nicht zu unterscheiden.
  const scheduledAt = parseTriggerAt(p.wirksamAbAt);
  if (scheduledAt === "invalid") return { ok: false, code: "ORGASM_INVALID_SEND_TIME" };
  const trigger = computeDelayedTrigger(now, { delayMinutes: p.delayMinutes, wirksamAbAt: scheduledAt });
  // Bei einer TERMINIERTEN Anweisung zählt der Auslöse-Zeitpunkt, nicht „jetzt": ein Fenster, das
  // vor seiner eigenen Zustellung endet, ist im Moment der Mail schon verstrichen — und mit
  // `art: "ANWEISUNG"` sofort ein Vergehen für eine Frist, die der Sub nie erfüllen konnte. Genau
  // der Fall, den `checkOrgasmWindowEnd` verhindert; er verschiebt sich mit der Terminierung nur.
  const windowEndError = checkOrgasmWindowEnd(endsAtDate, trigger.wirksamAb ?? now);
  if (windowEndError) return { ok: false, code: windowEndError };
  return { ok: true, window: { beginsAtDate, endsAtDate, ...trigger } };
}

export interface CreateOrgasmusAnforderungParams {
  userId: string;
  art: "ANWEISUNG" | "GELEGENHEIT";
  message?: string | null;
  /** Window start (ISO string or Date). */
  beginsAt: string | Date;
  /** Window end (ISO string or Date). Must be after beginsAt. */
  endsAt: string | Date;
  /** Required orgasm type base (from ORGASMUS_ARTEN); null/undefined = any orgasm counts. */
  requiredType?: string | null;
  /** Whether opening to perform the orgasm during the window is permitted (no Sperre break / penalty). */
  openingAllowed?: boolean;
  /** Terminierung — dieselben zwei Felder wie bei Kontrolle, Verschluss und Aufgabe
   *  ({@link computeDelayedTrigger}). Ohne beide löst die Anweisung sofort aus. */
  delayMinutes?: number | null;
  wirksamAbAt?: string | Date | null;
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
 *
 * `actor` ist WER anweist (Sitzung bzw. {@link AI_AUTHOR}) — als eigenes Argument wie bei allen
 * übrigen Diensten, UND als Spalte (`createdBy`), seit die Anweisung terminierbar ist: eine geplante
 * stellt der Poller zu, und dann ist der Handelnde nur noch dort nachlesbar. Dieselbe Begründung
 * wie bei `VerschlussAnforderung.createdBy`.
 */
export async function createOrgasmusAnforderung(
  params: CreateOrgasmusAnforderungParams,
  actor: MessageActor,
): Promise<ServiceResult<{ id: string; scheduledFor: string | null }>> {
  const { userId, art, message, beginsAt, endsAt, requiredType, openingAllowed, istStrafe, istBelohnung, fotoPflicht } = params;

  if (!userId) return serviceFail(400, "USER_ID_REQUIRED");
  const now = new Date();
  const checked = checkOrgasmusAnforderung(params, now);
  if (!checked.ok) return serviceFail(400, checked.code);
  const { beginsAtDate, endsAtDate, wirksamAb, benachrichtigtAt } = checked.window;
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return serviceFail(404, "USER_NOT_FOUND");
  // Gesundheits-Halt: die eine Bremse, die über allem steht. Das Gate der Zustellung
  // (`dueForDispatchWhere`) fasst nur TERMINIERTE Zeilen; ohne diese Prüfung ginge eine sofort
  // wirksame Anweisung mitten in der Pause hinaus, während ihr terminierter Zwilling wartet.
  // Die automatische Freigabe über das Gewicht prüft den Halt schon selbst (`weightReleaseService`).
  if (await isHealthHoldActive(userId)) return serviceFail(409, "HEALTH_HOLD_ACTIVE");
  // requiredType gegen die (ggf. angepasste) Orgasmus-Liste des Ziel-Subs prüfen; null-Config → Built-ins.
  if (requiredType && !orgasmusValueAllowed(requiredType, user.orgasmusArtenConfig)) {
    return serviceFail(400, "INVALID_ORGASM_TYPE");
  }

  // Withdraw existing open request + create the new one atomically (one active at a time).
  //
  // Die verdrängten Zeilen werden MITGELESEN: war eine davon dem Träger bekannt und ist die neue
  // TERMINIERT, verschwindet ihm sonst ein laufendes Fenster wortlos vom Dashboard — und ein Banner,
  // das grundlos verschwindet, verrät die Terminierung genauso wie eine verfrühte Meldung. Ist die
  // neue Anweisung sofort wirksam, meldet sie sich selbst; dann bleibt es wie bisher bei einer
  // Nachricht.
  let replacedVisible = false;
  //
  // Getrennter Scope (Fork): Belohnungs-Fenster (istBelohnung) und normale Anweisungen/Gelegenheiten
  // verdrängen sich NICHT gegenseitig — eine offene Strafe bleibt bestehen, wenn eine Belohnung
  // gewährt wird (und umgekehrt). Das Matching in /api/entries trennt sie über requiredType.
  const belohnung = Boolean(istBelohnung);
  const anforderung = await prisma.$transaction(async (tx) => {
    const offen = await tx.orgasmusAnforderung.findMany({
      where: { userId, fulfilledAt: null, withdrawnAt: null, istBelohnung: belohnung },
      select: { wirksamAb: true, benachrichtigtAt: true },
    });
    replacedVisible = offen.some((o) => !isHiddenFromSub(o));
    await tx.orgasmusAnforderung.updateMany({
      where: { userId, fulfilledAt: null, withdrawnAt: null, istBelohnung: belohnung },
      data: { withdrawnAt: new Date() },
    });
    return tx.orgasmusAnforderung.create({
      data: {
        userId,
        art,
        message: message?.trim() || null,
        beginsAt: beginsAtDate,
        endsAt: endsAtDate,
        requiredType: requiredType || null,
        openingAllowed: Boolean(openingAllowed),
        createdBy: actor ?? null,
        wirksamAb,
        benachrichtigtAt,
        istStrafe: Boolean(istStrafe),
        istBelohnung: belohnung,
        fotoPflicht: Boolean(fotoPflicht),
      },
    });
  });

  // Terminiert: kein Wort an den Sub, bis der Poller auslöst — eine Meldung jetzt verriete genau
  // das, was die Terminierung verbergen soll (`isHiddenFromSub`).
  if (!wirksamAb) {
    await sendOrgasmusAnforderungNotifications({
      user, art, message, beginsAtDate, endsAtDate, requiredType, openingAllowed: Boolean(openingAllowed),
      fotoPflicht: Boolean(fotoPflicht),
      directiveId: anforderung.id, actor,
    });
  } else if (replacedVisible) {
    // Nur der RÜCKZUG wird gemeldet, ohne ein Wort über die neue Anweisung: dass die alte weg ist,
    // sieht der Träger ohnehin, und wann die nächste kommt, geht ihn nichts an.
    await notifyUser(userId, orgasmusWithdrawNotice(actor));
  }

  return { ok: true, data: { id: anforderung.id, scheduledFor: wirksamAb?.toISOString() ?? null } };
}

/** Notification text shown to the user when an open orgasm directive is withdrawn — shared by the
 *  per-userId (MCP) and per-id (admin route) withdraw paths so the text isn't duplicated. */
export function orgasmusWithdrawNotice(actor: MessageActor, refId?: string): NotifyContent {
  // Wie beim Verschluss-Rückzug: ohne `refId` (Rückzug per userId, der mehrere offene Anweisungen
  // treffen kann) bleibt die Nachricht bewusst ohne Bezug — der ABSENDER bleibt trotzdem eindeutig,
  // der Rückzug ist EIN Knopfdruck EINER Person.
  return {
    subjectKey: "orgasmWithdrawnSubject",
    messageKey: "orgasmWithdrawnMessage",
    inbox: { actor, ...(refId ? { ref: { type: "orgasmDirective" as const, id: refId } } : {}) },
  };
}

/** Withdraws the user's currently open orgasm directive(s) (not yet fulfilled/withdrawn).
 *  Used by the MCP `withdraw` tool (userId-scoped — "neuste offene").
 *
 *  Gibt die stornierten Zeilen mit zurück, aus derselben Transaktion — der Aufrufer benennt sie in
 *  seiner Antwort (`withdrawnItems`) und muss sie nicht mit einer eigenen, potentiell abweichenden
 *  Abfrage nachschlagen. Gleiche Begründung wie bei `withdrawVerschlussAnforderung`.
 *
 *  Fork: aktive Belohnungs-Fenster (noch nicht abgelaufen), die durch DIESEN Rückzug fallen, bekommen
 *  ihr beim Gewähren abgebuchtes Guthaben erstattet — in derselben Transaktion. Bewusster Rückzug ≠
 *  Ablauf (VERFALLEN behält netto -1); abgelaufene Fenster bleiben dem VERFALLEN-Pfad
 *  (`getBelohnungState`) überlassen. */
export async function withdrawOrgasmusAnforderung(
  userId: string,
  actor: MessageActor,
): Promise<ServiceResult<{
  count: number;
  /** MIT den Sichtbarkeits-Feldern: die Zeile wird ohnehin so gelesen (siehe `select` unten), und der
   *  Aufrufer muss sonst raten, ob der Träger die zurückgezogene Anweisung überhaupt kannte —
   *  `mcpWithdraw` tat genau das und meldete jede als „ausgelöst". */
  rows: { id: string; endsAt: Date; message: string | null; wirksamAb: Date | null; benachrichtigtAt: Date | null }[];
}>> {
  const now = new Date();
  const rows = await prisma.$transaction(async (tx) => {
    const open = await tx.orgasmusAnforderung.findMany({
      where: { userId, fulfilledAt: null, withdrawnAt: null },
      select: { id: true, endsAt: true, message: true, wirksamAb: true, benachrichtigtAt: true, istBelohnung: true },
    });
    if (open.length > 0) {
      await tx.orgasmusAnforderung.updateMany({
        where: { id: { in: open.map((o) => o.id) } },
        data: { withdrawnAt: now },
      });
      const refund = open.filter((o) => o.istBelohnung && o.endsAt >= now).length;
      if (refund > 0) await refundReward(tx, userId, refund);
    }
    return open;
  });
  // Gemeldet wird nur, was der Sub überhaupt kennt: eine terminierte, noch nicht ausgelöste Anweisung
  // zurückzuziehen und ihm das zu melden, verriete sie im selben Atemzug (`isHiddenFromSub`).
  if (rows.some((o) => !isHiddenFromSub(o))) {
    await notifyUser(userId, orgasmusWithdrawNotice(actor));
  }
  return { ok: true, data: { count: rows.length, rows } };
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
 *  same row (`updateMany` scoped by id + open-status does the existence/open check via `count`; der `findFirst`
 *  davor holt NUR den Auslöse-Stand für die Melde-Entscheidung — und, Fork, ob ein noch laufendes
 *  Belohnungs-Fenster Guthaben zurückbekommt). Die Rückfrage im Keyholder-Bereich
 *  (`withdrawOrgasmConfirm`, `withdrawNotifiesSub`) beschreibt genau diese Regel. */
export async function withdrawOrgasmusAnforderungById(id: string, userId: string, actor: MessageActor): Promise<ServiceResult<{ count: number }>> {
  // Der Auslöse-Stand wird MITGELESEN, statt nur zu zählen: eine terminierte, noch nicht ausgelöste
  // Anweisung darf zwar zurückgezogen, aber nicht gemeldet werden (`isHiddenFromSub`) — und nach dem
  // `updateMany` ist er nicht mehr zu erfahren, ohne die Zeile ein zweites Mal zu laden. Die
  // Existenz-/Offen-Prüfung bleibt trotzdem am `updateMany` unten: zwischen Lesen und Schreiben kann
  // ein zweiter Rückzug dazwischenkommen, und nur der Schreibvorgang selbst entscheidet das.
  const now = new Date();
  const row = await prisma.orgasmusAnforderung.findFirst({
    where: { id, fulfilledAt: null, withdrawnAt: null },
    select: { wirksamAb: true, benachrichtigtAt: true, istBelohnung: true, endsAt: true },
  });
  const withdraw = (db: PrismaTx | typeof prisma) => db.orgasmusAnforderung.updateMany({
    where: { id, fulfilledAt: null, withdrawnAt: null },
    data: { withdrawnAt: now },
  });
  // Fork: ein noch laufendes Belohnungs-Fenster bekommt sein Guthaben zurück — dann (und nur dann)
  // laufen Rückzug und Erstattung in EINER Transaktion, und erstattet wird nur, wenn DIESER
  // Schreibvorgang die Zeile tatsächlich zurückgezogen hat. Sonst bleibt es beim schlichten
  // `updateMany` wie im Upstream.
  const refunds = !!row?.istBelohnung && row.endsAt >= now;
  const res = refunds
    ? await prisma.$transaction(async (tx) => {
        const r = await withdraw(tx);
        if (r.count > 0) await refundReward(tx, userId, 1);
        return r;
      })
    : await withdraw(prisma);
  if (res.count === 0) {
    return serviceFail(400, "ORGASM_NOT_OPEN");
  }
  if (row && !isHiddenFromSub(row)) {
    await notifyUser(userId, orgasmusWithdrawNotice(actor, id));
  }
  return { ok: true, data: { count: res.count } };
}

/** Sends the directive to the user on every channel their levels allow (`deliverToChannels`).
 *
 *  Exportiert für den Poller (`kontrollePoller.ts`), der die terminierten Anweisungen zustellt —
 *  dieselbe Meldung, nur später und mit dem Anordnenden aus `createdBy` statt aus der Sitzung. */
export async function sendOrgasmusAnforderungNotifications(opts: {
  /** Die GELADENE Zeile des Empfängers — geht weiter an `recordInboxDelivery` und `deliverToChannels`. */
  user: NotifyRecipient & { orgasmusArtenConfig: string | null };
  art: "ANWEISUNG" | "GELEGENHEIT";
  message?: string | null;
  beginsAtDate: Date;
  endsAtDate: Date;
  requiredType?: string | null;
  openingAllowed: boolean;
  /** Die Zeile, auf die die Nachricht im Posteingang zeigt. */
  directiveId: string;
  /** WER die Anweisung gestellt hat — der Absender ihrer Meldung. */
  actor: MessageActor;
  /** Fork: Foto-Nachweis beim Erfassen erforderlich — steht dann in Mail und Push. */
  fotoPflicht?: boolean;
}) {
  const { user, art, message, beginsAtDate, endsAtDate, requiredType, openingAllowed, fotoPflicht, directiveId, actor } = opts;
  const istAnweisung = art === "ANWEISUNG";

  // Nachricht des Keyholders bleibt an der Direktive; der Posteingang verlinkt sie nur.
  // Mail/Push/Telegram folgen dem Kanal-Schalter des Empfängers, die Zeile entsteht immer.
  const { badge, channels } = await recordInboxDelivery({
    subjectUserId: user.id,
    bodyKey: istAnweisung ? "orgasmAnweisungIntro" : "orgasmGelegenheitIntro",
    actor,
    ref: { type: "orgasmDirective", id: directiveId },
    once: true,
  }, user);
  const locale = toLocale(user.locale);
  const t = await emailT(locale);
  const betreff = istAnweisung ? t("orgasmAnweisungSubject") : t("orgasmGelegenheitSubject");
  const einleitung = istAnweisung ? t("orgasmAnweisungIntro") : t("orgasmGelegenheitIntro");
  const windowStr = `${formatDateTime(beginsAtDate)} – ${formatDateTime(endsAtDate)}`;

  // Reason-Code → Anzeige-Label gegen die Config des Ziel-Subs auflösen (sonst zeigt eine Custom-Art
  // den rohen `c_…`-Code in Mail/Push). In der Sprache des Empfängers, wie der restliche Text.
  const tOrgasm = localeT(locale, "orgasmForm");
  const artLabel = requiredType
    ? resolveOrgasmusArtDisplay(requiredType, effectiveOrgasmusArten(user.orgasmusArtenConfig), tOrgasm) ?? requiredType
    : null;

  const buildMail = () => {
    const messageHtml = optionalNoticeBoxHtml(t("orgasmNoticeLabel"), message);
    const artHtml = artLabel ? `<p><strong>${t("orgasmArtLabel")}</strong> ${escHtml(artLabel)}</p>` : "";
    const oeffnenHtml = openingAllowed ? `<p><strong>${t("orgasmOpenAllowedLabel")}</strong> ${t("orgasmOpenAllowedText")}</p>` : "";
    const fotoHtml = fotoPflicht ? `<p><strong>${t("orgasmPhotoLabel")}</strong> ${t("orgasmPhotoText")}</p>` : "";
    return {
      subject: betreff,
      html: dashboardEmailHtml(
        escHtml(betreff),
        `${emailGreeting(t, user.username)}
          <p>${escHtml(einleitung)}</p>
          ${messageHtml}
          <p><strong>${t("orgasmWindowLabel")}</strong> ${windowStr}</p>
          ${artHtml}
          ${oeffnenHtml}
          ${fotoHtml}`,
        t("dashboardButton"),
        { buttonColor: EMAIL_BUTTON_COLORS.orgasm },
      ),
    };
  };

  const pushParts: string[] = [`${t("orgasmWindowLabel")} ${windowStr}`];
  if (artLabel) pushParts.push(artLabel);
  if (fotoPflicht) pushParts.push(t("orgasmPhotoText"));
  if (message?.trim()) pushParts.push(message.trim());
  const pushBody = pushParts.join(" · ");
  await deliverToChannels(user, channels, { mail: buildMail, title: betreff, body: pushBody, url: "/dashboard", badge });
}
