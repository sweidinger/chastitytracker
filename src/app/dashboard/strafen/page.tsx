import DashboardBlock from "@/app/components/DashboardBlock";
import BackLink from "@/app/components/BackLink";
import { titleCls } from "@/app/components/inputStyles";
import { getTranslations } from "next-intl/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getStrafenForSub } from "@/lib/strafErledigung";
import StrafenClient, { type StrafeRow } from "./StrafenClient";

/** Eigene Strafen: offene melden (mit Nachweis), gemeldete warten auf Prüfung, erledigte im Rückblick. */
export default async function StrafenPage() {
  const session = await auth();
  const userId = session!.user.id;
  const t = await getTranslations("strafen");

  const [strafen, user] = await Promise.all([
    getStrafenForSub(userId),
    prisma.user.findUnique({ where: { id: userId }, select: { mobileDesktopUpload: true } }),
  ]);

  const rows: StrafeRow[] = strafen.map((s) => ({
    refId: s.refId,
    status: s.status,
    strafe: s.strafe,
    verhaengtAm: s.verhaengtAm.toISOString(),
    gemeldetAt: s.gemeldetAt?.toISOString() ?? null,
    erledigtAt: s.erledigtAt?.toISOString() ?? null,
    nachweisUrl: s.nachweisUrl,
    erledigungNotiz: s.erledigungNotiz,
    ablehnungGrund: s.ablehnungGrund,
  }));

  return (
    <DashboardBlock as="main">
      <div className="pt-6 flex flex-col gap-1.5 mb-4">
        <BackLink href="/dashboard">{t("back")}</BackLink>
        <h1 className={titleCls}>{t("title")}</h1>
        <p className="text-sm text-foreground-muted">{t("intro")}</p>
      </div>
      <StrafenClient strafen={rows} mobileDesktopMode={user?.mobileDesktopUpload ?? false} />
    </DashboardBlock>
  );
}
