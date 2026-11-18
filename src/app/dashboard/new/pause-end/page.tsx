import { EntryActionFormShell } from "@/app/components/AdminActionFormShell";
import { actionSign } from "@/app/entries/actionSign";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect, notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { nowDatetimeLocal, APP_TZ } from "@/lib/utils";
import { getActivePause } from "@/lib/pauseService";
import type { PauseDevice } from "@/lib/pauseService";
import PauseForm from "../../PauseForm";

export default async function PauseEndPage({ searchParams }: { searchParams: Promise<{ device?: string }> }) {
  const session = await auth();
  if (!session) redirect("/login");

  const { device: rawDevice } = await searchParams;
  if (rawDevice !== "CAGE" && rawDevice !== "PLUG") notFound();
  const device = rawDevice as PauseDevice;

  const userId = session.user.id;
  const tz = session.user.timezone ?? APP_TZ;

  const [dbUser, activePause] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { mobileDesktopUpload: true } }),
    getActivePause(userId, device),
  ]);

  // No active pause → redirect to start form
  if (!activePause) {
    redirect(`/dashboard/new/pause-start?device=${device}`);
  }

  const t = await getTranslations("pauseForm");
  const deviceLabel = device === "CAGE" ? t("deviceCage") : t("devicePlug");

  return (
    <EntryActionFormShell {...actionSign("REINIGUNG")} title={`${t("titleEnd")} · ${deviceLabel}`}>
      <PauseForm
        kind="end"
        device={device}
        activePauseSince={activePause.startTime.toISOString()}
        tz={tz}
        nowDefault={nowDatetimeLocal(tz)}
        mobileDesktopMode={dbUser?.mobileDesktopUpload ?? false}
      />
    </EntryActionFormShell>
  );
}
