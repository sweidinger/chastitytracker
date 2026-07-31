import Link from "next/link";
import VerschlussForm from "../../VerschlussForm";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getUserDeviceOptions, getIsLocked, getOpenLockRequest, getBoxFormContext } from "@/lib/queries";
import { bildersafeEnabled } from "@/lib/constants";
import { airlockEnabled } from "@/lib/airlock/config";
import { getAssignedLocks } from "@/lib/airlock/service";
import { nowDatetimeLocal, APP_TZ } from "@/lib/utils";

export default async function NewVerschlussPage() {
  const session = await auth();
  const userId = session!.user.id;
  const tz = session!.user.timezone ?? APP_TZ;

  const [isLocked, dbUser, devices, offeneAnforderung, box, airlockOn, assignedLocks] = await Promise.all([
    getIsLocked(userId),
    prisma.user.findUnique({ where: { id: userId }, select: { mobileDesktopUpload: true } }),
    getUserDeviceOptions(userId),
    getOpenLockRequest(userId),
    getBoxFormContext(userId),
    airlockEnabled(),
    getAssignedLocks(userId),
  ]);

  if (isLocked) redirect("/dashboard");

  const { boxConfirm, boxName } = box;
  const airlockAssignedCodes = airlockOn ? assignedLocks.map((l) => l.code) : [];
  const anforderungAirlockCode = airlockOn ? (offeneAnforderung?.airlockCode ?? null) : null;
  // Sicherheits-Feature: gibt es dem Sub zugewiesene, noch NICHT verifizierte Locks? → Hinweis + Link.
  const hasUnverified = airlockOn && assignedLocks.some((l) => !l.verifiedAt);

  const tn = await getTranslations("newEntry");
  const tf = await getTranslations("lockForm");
  const tv = await getTranslations("airlockVerify");
  return (
    <div className="w-full max-w-2xl mx-auto px-4 py-6">
      <Link href="/dashboard" className="text-sm text-foreground-faint hover:text-foreground-muted transition">{tn("back")}</Link>
      <h1 className="text-xl font-bold text-foreground mt-1 mb-6">{tf("title")}</h1>
      {hasUnverified && (
        <Link
          href="/dashboard/airlock"
          className="mb-6 block rounded-xl border border-inspect/40 bg-inspect/10 px-4 py-3 text-sm text-inspect hover:bg-inspect/15 transition"
        >
          {tv("gateNotice")}
        </Link>
      )}
      <VerschlussForm
        tz={tz}
        nowDefault={nowDatetimeLocal(tz)}
        mobileDesktopMode={dbUser?.mobileDesktopUpload ?? false}
        devices={devices}
        anforderungDeviceId={offeneAnforderung?.deviceId ?? null}
        bildersafe={!boxConfirm && bildersafeEnabled()}
        boxConfirm={boxConfirm}
        boxName={boxName}
        airlockAssignedCodes={airlockAssignedCodes}
        anforderungAirlockCode={anforderungAirlockCode}
      />
    </div>
  );
}
