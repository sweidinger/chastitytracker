import { redirect } from "next/navigation";
import { assertKeyholderOrAdmin } from "@/lib/authGuards";
import { airlockEnabled } from "@/lib/airlock/config";
import { getAssignedLocks, getActiveAirlockCode, syncAndListLocks } from "@/lib/airlock/service";
import AirlockAssignmentForm from "./AirlockAssignmentForm";

export const dynamic = "force-dynamic";

/** Sub-Tab „Airlock" (nur Global-Admin): weist diesem Sub ein verfügbares Lock zu bzw. gibt es frei.
 *  Die Verbindungs-Einstellungen liegen zentral unter /admin/airlock. */
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

  // Verfügbare Locks aus dem Sync; bei „nicht erreichbar" leere Liste + Hinweis. Die zugewiesenen Locks
  // kommen aus der DB (getAssignedLocks) und werden unabhängig vom Airlock-Zustand gezeigt.
  const available = locksRes.ok
    ? locksRes.data.filter((l) => l.available).map((l) => ({ code: l.code, status: l.status, nfcUid: l.nfcUid }))
    : [];
  const locksError: "unreachable" | "error" | null = locksRes.ok
    ? null
    : (locksRes.unreachable ? "unreachable" : "error");

  const assigned = assignedRows.map((r) => ({ code: r.code, status: r.status, nfcUid: r.nfcUid }));

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
