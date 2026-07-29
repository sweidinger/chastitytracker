import { redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { auth } from "@/lib/auth";
import { listActiveManualPools } from "@/lib/zufallService";
import ZufallsRad from "./ZufallsRad";

/** Sub-Sicht des Schicksalsrads. Auth über die Middleware (proxy.ts) + die API-Route; hier wird die
 *  Pool-Liste (nur id + name, KEINE Gewichte) serverseitig geladen und an das Rad übergeben. */
export default async function ZufallPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const [pools, t] = await Promise.all([
    listActiveManualPools(session.user.id),
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
      <ZufallsRad pools={pools} />
    </main>
  );
}
