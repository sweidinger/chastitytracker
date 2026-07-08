import Link from "next/link";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect, notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { nowDatetimeLocal, APP_TZ } from "@/lib/utils";
import { getActivePause } from "@/lib/pauseService";
import type { PauseDevice } from "@/lib/pauseService";
import PauseForm from "../../PauseForm";

export default async function PauseStartPage({ searchParams }: { searchParams: Promise<{ device?: string }> }) {
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

  // Already paused → redirect to end form
  if (activePause) {
    redirect(`/dashboard/new/pause-end?device=${device}`);
  }

  const t = await getTranslations("pauseForm");
  const deviceLabel = device === "CAGE" ? t("deviceCage") : t("devicePlug");

  return (
    <div className="w-full max-w-2xl mx-auto px-4 py-6">
      <Link href="/dashboard" className="text-sm text-foreground-faint hover:text-foreground-muted transition">
        ← {t("back")}
      </Link>
      <h1 className="text-xl font-bold text-foreground mt-1 mb-6">
        {t("titleStart")} · {deviceLabel}
      </h1>
      <PauseForm
        kind="begin"
        device={device}
        tz={tz}
        nowDefault={nowDatetimeLocal(tz)}
        mobileDesktopMode={dbUser?.mobileDesktopUpload ?? false}
      />
    </div>
  );
}
