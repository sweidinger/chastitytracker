import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { assertKeyholderOrAdmin } from "@/lib/authGuards";
import { getTranslations } from "next-intl/server";
import { airlockEnabled } from "@/lib/airlock/config";
import { getAssignedLocks, getActiveAirlockCode, syncAndListLocks } from "@/lib/airlock/service";
import AirlockAssignmentForm from "./AirlockAssignmentForm";
import AirlockVerifyList from "@/app/dashboard/AirlockVerifyList";

export const dynamic = "force-dynamic";

/** Sub-Tab „Airlock" (nur Global-Admin): weist diesem Sub ein verfügbares Lock zu bzw. gibt es frei.
 *  Betrachtet der Admin den EIGENEN Tab (Self-Lock), steht oben zusätzlich die Verifizierung der eigenen
 *  Schlösser (Tag-Scan) — dieselbe Ansicht wie /dashboard/airlock. Die Verbindungs-Einstellungen liegen
 *  zentral unter /admin/airlock. */
export default async function UserAirlockPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { isGlobalAdmin } = await assertKeyholderOrAdmin(id);
  if (!isGlobalAdmin) redirect(`/admin/users/${id}`);

  const session = await auth();
  const isSelf = session?.user?.id === id;

  const [airlockOn, assignedRows, activeCode, locksRes] = await Promise.all([
    airlockEnabled(),
    getAssignedLocks(id),
    getActiveAirlockCode(id),
    syncAndListLocks(),
  ]);

  const available = locksRes.ok
    ? locksRes.data.filter((l) => l.available).map((l) => ({ code: l.code, status: l.status, nfcUid: l.nfcUid }))
    : [];
  const locksError: "unreachable" | "error" | null = locksRes.ok
    ? null
    : (locksRes.unreachable ? "unreachable" : "error");

  const assigned = assignedRows.map((r) => ({ code: r.code, status: r.status, nfcUid: r.nfcUid, verified: !!r.verifiedAt }));
  const verifyItems = assignedRows.map((r) => ({ code: r.code, verified: !!r.verifiedAt }));
  const tv = await getTranslations("airlockVerify");

  return (
    <div className="flex flex-col gap-6">
      {isSelf && airlockOn && verifyItems.length > 0 && (
        <div className="flex flex-col gap-2">
          <div>
            <h2 className="text-base font-semibold text-foreground">{tv("title")}</h2>
            <p className="text-sm text-foreground-muted mt-0.5">{tv("intro")}</p>
          </div>
          <AirlockVerifyList items={verifyItems} />
        </div>
      )}
      <AirlockAssignmentForm
        userId={id}
        assigned={assigned}
        activeCode={activeCode}
        available={available}
        airlockOn={airlockOn}
        locksError={locksError}
      />
    </div>
  );
}
