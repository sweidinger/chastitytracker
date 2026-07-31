import { assertAdmin } from "@/lib/authGuards";
import { getAirlockConfigSafe } from "@/lib/airlock/config";
import AirlockAdminClient from "./AirlockAdminClient";

export const dynamic = "force-dynamic";

/** Globale Airlock-Verwaltung (nur Global-Admin): Verbindung, Verbindungstest + Log, Lock-Inventar.
 *  Die Zuweisung eines Locks an einen Sub passiert im Sub-Tab (/admin/users/[id]/airlock). */
export default async function AirlockAdminPage() {
  await assertAdmin();
  const config = await getAirlockConfigSafe();

  return (
    <main className="w-full max-w-2xl mx-auto px-4 py-6">
      <AirlockAdminClient initial={config} />
    </main>
  );
}
