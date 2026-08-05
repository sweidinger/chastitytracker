import { getTranslations } from "next-intl/server";
import { prisma } from "@/lib/prisma";
import { notifyUser } from "@/lib/notify";
import { getControllersOfUser } from "@/lib/keyholder";
import { createOeffnenEntryTx } from "@/lib/oeffnenService";
import { getActivePause, pauseReasonsForDevice, pauseSettingsForDevice } from "@/lib/pauseService";
import { PAUSE_ABGELAUFEN_REASON, toLocale } from "@/lib/constants";
import { codeOf } from "@/lib/codedError";

/** User-Felder für die Pause-Grund-/Limit-Ableitung (CAGE: reinigung/toilette) plus Anzeige. */
const PAUSE_USER_SELECT = {
  username: true,
  locale: true,
  reinigungErlaubt: true,
  reinigungMaxMinuten: true,
  reinigungMaxProTag: true,
  toiletteErlaubt: true,
  toiletteMaxMinuten: true,
  toiletteMaxProTag: true,
  plugReinigungErlaubt: true,
  plugReinigungMaxMinuten: true,
  plugReinigungMaxProTag: true,
  plugToiletteMaxMinuten: true,
} as const;

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Poller-Schritt: findet aktive CAGE-Pausen, die ihre konfigurierte Maximaldauer ueberschritten
 * haben, und setzt sie durch — genau EINE Oeffnung pro ueberzogener Pause:
 *  1. In einer Transaktion einen OEFFNEN-Eintrag (Grund PAUSE_ABGELAUFEN, source "system")
 *     erzeugen. Das oeffnet den Kaefig und beendet die Session; die Pause gilt danach als beendet,
 *     weil getActivePause die Oeffnung als Session-Grenze wertet (KEIN PAUSE_END noetig/erwuenscht —
 *     ein PAUSE_END hiesse Wiederverschluss, was NICHT passiert ist).
 *  2. Der Ueberzug erscheint im Strafbuch (pauseOverageViolations, Zwangsoeffnungs-Zweig) und damit
 *     im Kontext der AI-Keyholderin — Urteil/Strafe entscheidet die Keyholderin.
 *  3. Sub + Keyholder werden benachrichtigt (NACH dem Commit, nicht transaktional).
 * Bewusst NUR CAGE: eine Plug-Pause endet ueber WEAR_END, nicht ueber eine Oeffnung.
 * Modelliert nach autoMarkInspectionRemoved (inspectionEscalationService.ts).
 */
export async function enforceExpiredCagePauses(now: Date = new Date()): Promise<number> {
  const candidates = await prisma.entry.findMany({
    where: {
      type: "PAUSE_BEGIN",
      pauseDevice: "CAGE",
      startTime: { gte: new Date(now.getTime() - THIRTY_DAYS_MS) },
    },
    distinct: ["userId"],
    select: { userId: true },
  });

  let enforced = 0;
  for (const { userId } of candidates) {
    try {
      const active = await getActivePause(userId, "CAGE");
      if (!active) continue;

      const [user, pauseEntry] = await Promise.all([
        prisma.user.findUnique({ where: { id: userId }, select: PAUSE_USER_SELECT }),
        prisma.entry.findUnique({ where: { id: active.id }, select: { oeffnenGrund: true } }),
      ]);
      if (!user) continue;

      const grund = pauseEntry?.oeffnenGrund ?? null;
      const reasons = pauseReasonsForDevice(user, "CAGE");
      const maxMin =
        (grund ? reasons.find((r) => r.grund === grund)?.maxMinuten : undefined) ??
        pauseSettingsForDevice(user, "CAGE").maxMinuten;
      if (maxMin <= 0) continue; // 0 = unbegrenzt -> keine Durchsetzung

      const elapsedMin = (now.getTime() - active.startTime.getTime()) / 60000;
      if (elapsedMin <= maxMin) continue; // noch im Limit

      const tOpen = await getTranslations({ locale: toLocale(user.locale), namespace: "openForm" });
      const note = tOpen("pauseExpiredNote", { minutes: Math.round(elapsedMin - maxMin) });

      try {
        await prisma.$transaction((tx) =>
          createOeffnenEntryTx(tx, {
            userId,
            startTime: now,
            oeffnenGrund: PAUSE_ABGELAUFEN_REASON,
            note,
            source: "system",
          }),
        );
      } catch (e: unknown) {
        // Sub hat sich zwischenzeitlich selbst geoeffnet -> nichts mehr durchzusetzen.
        if (codeOf(e) === "NOT_LOCKED" || codeOf(e) === "TIME_BEFORE") continue;
        throw e;
      }

      enforced++;
      await notifyPauseExpired(userId, user.username);
    } catch (e) {
      console.error(`[pauseOverstay] enforce failed for user ${userId}:`, e);
    }
  }
  return enforced;
}

/** Benachrichtigt Sub + Keyholder/Admins ueber die automatische Oeffnung. Nach dem Commit aufrufen. */
async function notifyPauseExpired(userId: string, username: string): Promise<void> {
  await notifyUser(userId, {
    subjectKey: "pauseExpiredSubjectSub",
    messageKey: "pauseExpiredMessageSub",
  });
  const controllers = await getControllersOfUser(userId);
  await Promise.all(
    controllers.map((c) =>
      notifyUser(c.id, {
        subjectKey: "pauseExpiredSubjectKeyholder",
        messageKey: "pauseExpiredMessageKeyholder",
        params: { username },
        inbox: false,
      }),
    ),
  );
}
