import { prisma } from "@/lib/prisma";
import { sendPushToUser } from "@/lib/push";

const DAY_MS = 86_400_000;

/** Prueft, ob der Sub gerade einen neuen orgasmusfreien Rekord (in ganzen Tagen) aufgestellt hat, und
 *  meldet ihn per Push. `denialRecordDays` = hoechster bereits gemeldeter Rekord-Tag (verhindert
 *  Wiederholung; genau ein Push pro neuem Rekord-Tag). Der Rekord wird nur ueberschritten, wenn die
 *  laufende Straehne die bisher LAENGSTE (abgeschlossene) Straehne uebertrifft. */
export async function checkDenialMilestone(userId: string, now: Date): Promise<boolean> {
  const orgs = await prisma.entry.findMany({
    where: { userId, type: "ORGASMUS" },
    orderBy: { startTime: "asc" },
    select: { startTime: true },
  });
  if (orgs.length === 0) return false;

  let longestCompletedMs = 0;
  for (let i = 1; i < orgs.length; i++) {
    const g = orgs[i].startTime.getTime() - orgs[i - 1].startTime.getTime();
    if (g > longestCompletedMs) longestCompletedMs = g;
  }
  const last = orgs[orgs.length - 1].startTime;
  const curDays = Math.floor((now.getTime() - last.getTime()) / DAY_MS);
  const longestCompletedDays = Math.floor(longestCompletedMs / DAY_MS);

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { denialRecordDays: true } });
  const record = Math.max(user?.denialRecordDays ?? 0, longestCompletedDays);

  if (curDays >= 1 && curDays > record) {
    await prisma.user.update({ where: { id: userId }, data: { denialRecordDays: curDays } });
    await sendPushToUser(userId, "Neuer Rekord", `${curDays} Tage ohne Orgasmus – deine laengste Straehne bisher!`, "/dashboard/stats");
    return true;
  }
  // Rekord ohne Push nachziehen, damit er nie hinter die abgeschlossene Historie zurueckfaellt.
  if (record > (user?.denialRecordDays ?? 0)) {
    await prisma.user.update({ where: { id: userId }, data: { denialRecordDays: record } });
  }
  return false;
}
