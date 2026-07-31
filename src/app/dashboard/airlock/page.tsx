import Link from "next/link";
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
  const items = locks.map((l) => ({ code: l.code, verified: !!l.verifiedAt }));

  return (
    <div className="w-full max-w-2xl mx-auto px-4 py-6">
      <Link href="/dashboard" className="text-sm text-foreground-faint hover:text-foreground-muted transition">←</Link>
      <h1 className="text-xl font-bold text-foreground mt-1 mb-1">{t("title")}</h1>
      <p className="text-sm text-foreground-muted mb-6">{t("intro")}</p>
      <AirlockVerifyList items={items} />
    </div>
  );
}
