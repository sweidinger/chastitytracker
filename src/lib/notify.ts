import { prisma } from "@/lib/prisma";
import { sendMailSafe, escHtml, dashboardEmailHtml } from "@/lib/mail";
import { emailT, emailGreeting } from "@/lib/emailI18n";
import { firePush } from "@/lib/push";

/**
 * Content of a generic notification, expressed as i18n keys (namespace `emails`) rather than
 * literal text. notifyUser() resolves them in the RECIPIENT's stored language, so subject, mail
 * body and push all arrive translated. `params` are interpolated into both subject and message.
 */
export interface NotifyContent {
  subjectKey: string;
  messageKey: string;
  params?: Record<string, string | number>;
  url?: string;
}

/**
 * Generischer Benachrichtigungs-Helper für einfache Status-Meldungen an den Nutzer
 * (E-Mail + Push). Subject + Message werden in der Sprache des Empfängers gerendert und sowohl
 * im Mail-Body als auch im Push verwendet. Push ist fire-and-forget; ohne hinterlegte E-Mail
 * wird nur Push versendet.
 *
 * Für reichhaltige, mehrzeilige Benachrichtigungen (z.B. Verschluss/Orgasmus mit Fenster + Frist)
 * gibt es weiterhin die spezialisierten send…Notifications-Helfer in den jeweiligen Services.
 */
export async function notifyUser(userId: string, content: NotifyContent): Promise<void> {
  const { subjectKey, messageKey, params, url = "/dashboard" } = content;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, username: true, locale: true } });
  if (!user) return;

  const t = await emailT(user.locale);
  const subject = t(subjectKey, params);
  const message = t(messageKey, params);

  if (user.email) {
    await sendMailSafe(
      user.email,
      `KG-Tracker – ${subject}`,
      dashboardEmailHtml(subject, `${emailGreeting(t, user.username)}<p>${escHtml(message)}</p>`, t("dashboardButton")),
    );
  }
  firePush(userId, subject, message, url);
}


// ==== ported from upstream (Tasks #39) ====
/**
 * Dieselbe Meldung an die Keyholder eines Subs — Mail und Push, aber NIE eine Posteingangs-Zeile.
 *
 * Der Posteingang gehört dem Sub: eine Nachricht mit der `subjectUserId` des Keyholders landete in
 * dessen persönlichem Posteingang, als wäre sie seine eigene Direktive — ohne Fehler, nur falsch
 * einsortiert. Der Keyholder-Kanal kommt mit Etappe 2 (docs/nachrichten-konzept.md).
 *
 * `inbox` ist deshalb aus dem Content-Typ ausgeschlossen und wird hier gesetzt: ein Aufrufer KANN es
 * nicht vergessen. Die Empfänger kommen als Parameter statt aus `getControllersOfUser` —
 * `processDueTasks` holt sie bewusst einmal je Nutzer statt einmal je Aufgabe.
 */
export async function notifyControllers(
  controllers: { id: string }[],
  content: Omit<NotifyContent, "inbox">,
): Promise<void> {
  await Promise.all(controllers.map((c) => notifyUser(c.id, { ...content, inbox: false })));
}
