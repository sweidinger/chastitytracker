import { redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { auth } from "@/lib/auth";
import { listActiveManualPools, listZiehungen } from "@/lib/zufallService";
import ZufallsRad from "./ZufallsRad";

/** Sub-Sicht des Schicksalsrads. Auth über die Middleware (proxy.ts) + die API-Route; hier wird die
 *  Pool-Liste (nur id + name + Cooldown, KEINE Gewichte) sowie die letzten Ziehungen serverseitig
 *  geladen und ans Rad übergeben. */
export default async function ZufallPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const [pools, history, t] = await Promise.all([
    listActiveManualPools(session.user.id),
    listZiehungen(session.user.id, 10),
    getTranslations("zufall"),
  ]);

  return (
    <main className="w-full max-w-lg mx-auto px-4 py-6 flex flex-col gap-4">
      <Link href="/dashboard" className="inline-flex items-center gap-1 text-sm text-foreground-faint hover:text-foreground transition">
        <ArrowLeft size={16} /> {t("back")}
      </Link>
      <div>
        <h1 className="text-lg font-semibold text-foreground">{t("title")}</h1>
        <p className="text-sm text-foreground-faint mt-1">{t("intro")}</p>
      </div>
      <ZufallsRad pools={pools} initialHistory={history} />
    </main>
  );
}
