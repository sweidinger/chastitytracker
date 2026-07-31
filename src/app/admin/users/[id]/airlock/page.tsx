import { redirect } from "next/navigation";
import { assertKeyholderOrAdmin } from "@/lib/authGuards";
import { airlockEnabled } from "@/lib/airlock/config";
import { getAssignedLocks, getActiveAirlockCode, syncAndListLocks } from "@/lib/airlock/service";
import AirlockAssignmentForm from "./AirlockAssignmentForm";

export const dynamic = "force-dynamic";

/** Sub-Tab „Airlock" (nur Global-Admin): weist diesem Sub verfügbare Locks zu bzw. gibt sie frei und
 *  zeigt pro Lock den Verifiziert-Status (Badge). Das VERIFIZIEREN selbst macht ausschließlich der Sub
 *  in seinem eigenen Bereich (/dashboard/airlock) — er hält den Tag. Verbindung/Key liegen zentral
 *  unter /admin/airlock. */
export default async function UserAirlockPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { isGlobalAdmin } = await assertKeyholderOrAdmin(id);
  if (!isGlobalAdmin) redirect(`/admin/users/${id}`);

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

  return (
    <AirlockAssignmentForm
      userId={id}
      assigned={assigned}
      activeCode={activeCode}
      available={available}
      airlockOn={airlockOn}
      locksError={locksError}
    />
  );
}
