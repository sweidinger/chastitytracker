import DashboardBlock from "@/app/components/DashboardBlock";
import BackLink from "@/app/components/BackLink";
import { titleCls } from "@/app/components/inputStyles";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getTranslations } from "next-intl/server";
import { airlockEnabled } from "@/lib/airlock/config";
import { getAssignedLocks } from "@/lib/airlock/service";
import AirlockVerifyList from "../AirlockVerifyList";

/**
 * Sub-seitige Verwaltung der zugewiesenen Airlock-Schlösser: jedes muss einmal per Tag-Scan
 * verifiziert werden (Sicherheits-Feature), bevor es zum Verschluss nutzbar ist.
 */
export default async function MyAirlockLocksPage() {
  const session = await auth();
  const userId = session!.user.id;
  if (!(await airlockEnabled())) redirect("/dashboard");

  const locks = await getAssignedLocks(userId);
  const t = await getTranslations("airlockVerify");
  const tn = await getTranslations("nav");
  const items = locks.map((l) => ({ code: l.code, verified: !!l.verifiedAt }));

  return (
    <DashboardBlock as="main">
      <div className="pt-6 flex flex-col gap-1.5 mb-6">
        <BackLink href="/dashboard">{tn("overview")}</BackLink>
        <h1 className={titleCls}>{t("title")}</h1>
        <p className="text-sm text-foreground-muted">{t("intro")}</p>
      </div>
      <AirlockVerifyList items={items} />
    </DashboardBlock>
  );
}
