import { EntryActionFormShell } from "@/app/components/AdminActionFormShell";
import { actionSign } from "@/app/entries/actionSign";
import VerschlussForm from "../../VerschlussForm";
import { auth } from "@/lib/auth";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getUserDeviceOptions, getIsLocked, getOpenLockRequest, getBoxFormContext, getMobileDesktopMode, pendingLockCallAt } from "@/lib/queries";
import { bildersafeEnabled } from "@/lib/constants";
import { airlockEnabled } from "@/lib/airlock/config";
import { getAssignedLocks } from "@/lib/airlock/service";
import { nowDatetimeLocal, safeInternalPath, APP_TZ } from "@/lib/utils";

export default async function NewVerschlussPage({ searchParams }: { searchParams: Promise<{ redirectTo?: string }> }) {
  // Aus der URL (Ketten-Weiterleitung der Aufgaben-Bedingungen) → geprüft, siehe safeInternalPath.
  const target = safeInternalPath((await searchParams).redirectTo) ?? undefined;
  const session = await auth();
  const userId = session!.user.id;
  const tz = session!.user.timezone ?? APP_TZ;

  const [isLocked, lockCallAt, mobileDesktopMode, devices, offeneAnforderung, box, airlockOn, assignedLocks] = await Promise.all([
    getIsLocked(userId),
    // Ein wartender Aufruf schliesst einen zweiten aus (`LOCK_ALREADY_PENDING`) — dann gehört der
    // Träger zurück auf die Übersicht, wo der Zustands-Held ihm sagt, was zu tun ist.
    pendingLockCallAt(userId),
    getMobileDesktopMode(userId),
    getUserDeviceOptions(userId),
    getOpenLockRequest(userId),
    getBoxFormContext(userId),
    airlockEnabled(),
    getAssignedLocks(userId),
  ]);

  if (isLocked || lockCallAt) redirect("/dashboard");

  const { boxConfirm, boxName, requiresBolt } = box;
  const airlockAssignedCodes = airlockOn ? assignedLocks.map((l) => l.code) : [];
  const anforderungAirlockCode = airlockOn ? (offeneAnforderung?.airlockCode ?? null) : null;
  // Sicherheits-Feature: gibt es dem Sub zugewiesene, noch NICHT verifizierte Locks? → Hinweis + Link.
  const hasUnverified = airlockOn && assignedLocks.some((l) => !l.verifiedAt);
  const tf = await getTranslations("lockForm");
  const tv = await getTranslations("airlockVerify");
  return (
    <EntryActionFormShell {...actionSign("VERSCHLUSS")} title={tf("title")}>
      {hasUnverified && (
        <Link
          href="/dashboard/airlock"
          className="block rounded-xl border border-inspect/40 bg-inspect/10 px-4 py-3 text-fliess text-inspect hover:bg-inspect/15 transition"
        >
          {tv("gateNotice")}
        </Link>
      )}
      <VerschlussForm
        tz={tz}
        nowDefault={nowDatetimeLocal(tz)}
        mobileDesktopMode={mobileDesktopMode}
        devices={devices}
        anforderungDeviceId={offeneAnforderung?.deviceId ?? null}
        redirectTo={target}
        bildersafe={!boxConfirm && bildersafeEnabled()}
        boxConfirm={boxConfirm}
        boxName={boxName}
        boltGated={requiresBolt}
        airlockAssignedCodes={airlockAssignedCodes}
        anforderungAirlockCode={anforderungAirlockCode}
      />
    </EntryActionFormShell>
  );
}
