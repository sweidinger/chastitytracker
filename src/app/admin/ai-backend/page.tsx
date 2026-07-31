import { assertAdmin } from "@/lib/authGuards";
import { getAiBackendSafe } from "@/lib/aiKeyholder/backendConfig";
import AiBackendClient from "./AiBackendClient";

export const dynamic = "force-dynamic";

/** Globale KI-Backend-Verwaltung (nur Global-Admin): LLM- + Medien-Verbindung der AI-Keyholderin,
 *  instanzweit (Singleton). Persona/Verhalten pro Sub bleiben im jeweiligen AI-Keyholderin-Tab. */
export default async function AiBackendPage() {
  await assertAdmin();
  const config = await getAiBackendSafe();
  return (
    <main className="w-full max-w-2xl mx-auto px-4 py-6">
      <AiBackendClient initial={config} />
    </main>
  );
}
