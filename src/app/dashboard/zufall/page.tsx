import { redirect } from "next/navigation";
import DashboardBlock from "@/app/components/DashboardBlock";
import BackLink from "@/app/components/BackLink";
import { titleCls } from "@/app/components/inputStyles";
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
    <DashboardBlock as="main">
      <div className="pt-6 flex flex-col gap-4">
        <BackLink href="/dashboard">{t("back")}</BackLink>
        <div className="flex flex-col gap-1.5">
          <h1 className={titleCls}>{t("title")}</h1>
          <p className="text-sm text-foreground-faint">{t("intro")}</p>
        </div>
        <ZufallsRad pools={pools} initialHistory={history} />
      </div>
    </DashboardBlock>
  );
}
