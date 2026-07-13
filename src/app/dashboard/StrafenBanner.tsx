import Link from "next/link";
import { Gavel, Clock, ChevronRight } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { countOffeneStrafen } from "@/lib/strafErledigung";

/** Dashboard: Hinweis auf offene bzw. zur Prüfung gemeldete Strafen. Nur sichtbar, wenn es welche gibt. */
export default async function StrafenBanner({ userId }: { userId: string }) {
  const t = await getTranslations("strafen");
  const { offen, gemeldet } = await countOffeneStrafen(userId);
  if (offen === 0 && gemeldet === 0) return null;

  // Offene Strafen dominieren die Farbe — sie verlangen Handeln; reine Prüfung ist nur Information.
  const color = offen > 0 ? "var(--color-warn)" : "var(--color-inspect)";
  const Icon = offen > 0 ? Gavel : Clock;

  return (
    <div className="w-full max-w-2xl mx-auto px-4 pt-4">
      <Link
        href="/dashboard/strafen"
        className="flex items-center gap-4 rounded-2xl border px-5 py-4 transition hover:opacity-90"
        style={{ borderColor: color, background: `color-mix(in srgb, ${color} 8%, transparent)` }}
      >
        <div
          className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0"
          style={{ background: `color-mix(in srgb, ${color} 15%, transparent)`, color }}
        >
          <Icon size={24} strokeWidth={2} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold uppercase tracking-widest opacity-80" style={{ color }}>
            {t("bannerTitle")}
          </p>
          <p className="text-sm text-foreground">
            {offen > 0 && <span className="font-bold">{t("bannerOpen", { count: offen })}</span>}
            {offen > 0 && gemeldet > 0 && " · "}
            {gemeldet > 0 && <span>{t("bannerPending", { count: gemeldet })}</span>}
          </p>
        </div>
        <ChevronRight size={18} className="text-foreground-faint flex-shrink-0" />
      </Link>
    </div>
  );
}
