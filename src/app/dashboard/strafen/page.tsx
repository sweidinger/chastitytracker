import Link from "next/link";
import { ArrowLeft } from "lucide-react";
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
    <div className="w-full max-w-2xl mx-auto px-4 py-6">
      <Link href="/dashboard" className="inline-flex items-center gap-1.5 text-sm text-foreground-muted hover:text-foreground transition mb-4">
        <ArrowLeft size={16} />
        {t("back")}
      </Link>
      <h1 className="text-xl font-bold text-foreground mb-1">{t("title")}</h1>
      <p className="text-sm text-foreground-muted mb-4">{t("intro")}</p>
      <StrafenClient strafen={rows} mobileDesktopMode={user?.mobileDesktopUpload ?? false} />
    </div>
  );
}
