import { getTranslations, getLocale } from "next-intl/server";
import { Gift, Award, Hourglass, Ban, Clock, Gavel, ShieldOff, History } from "lucide-react";
import Card from "./Card";
import EmptyState from "./EmptyState";
import { getHistorie, type HistorieItem } from "@/lib/historie";
import { formatDateTime } from "@/lib/utils";

/**
 * Belohnungs-/Straf-Historie: Kennzahlen, Guthaben-Verlauf (Sparkline), Monatsbalken und Zeitleiste.
 * Server-Komponente — geteilt von der eigenen Statistik-Seite und der Admin-User-Statistik.
 */

/** Farbe + Icon je Ereignis-Typ. Positives = ok, Negatives = warn, Neutrales = muted. */
const EVENT_STYLE: Record<string, { color: string; Icon: typeof Gift }> = {
  VERDIENT:   { color: "var(--color-ok)",      Icon: Award },
  GEWAEHRT:   { color: "var(--color-ok)",      Icon: Gift },
  EINGELOEST: { color: "var(--color-orgasm)",  Icon: Gift },
  VERFALLEN:  { color: "var(--color-inspect)", Icon: Hourglass },
  ERSTATTET:  { color: "var(--color-ok)",      Icon: Award },
  ENTZOGEN:   { color: "var(--color-warn)",    Icon: Ban },
  VERSCHOBEN: { color: "var(--color-warn)",    Icon: Clock },
  PUNISHED:   { color: "var(--color-warn)",    Icon: Gavel },
  DISMISSED:  { color: "var(--color-unlock)",  Icon: ShieldOff },
};

/** Guthaben-Verlauf als Stufenlinie (reines SVG, keine Chart-Library). */
function BalanceChart({ series }: { series: { at: Date; balance: number }[] }) {
  const W = 320, H = 64, PAD = 4;
  const max = Math.max(1, ...series.map((s) => s.balance));
  const n = series.length;
  const x = (i: number) => PAD + (n === 1 ? W - 2 * PAD : ((W - 2 * PAD) * i) / (n - 1));
  const y = (v: number) => H - PAD - ((H - 2 * PAD) * v) / max;

  // Stufen: das Guthaben bleibt zwischen zwei Ereignissen konstant.
  const d = series
    .map((s, i) => (i === 0 ? `M ${x(0)} ${y(s.balance)}` : `L ${x(i)} ${y(series[i - 1].balance)} L ${x(i)} ${y(s.balance)}`))
    .join(" ");
  const area = `${d} L ${x(n - 1)} ${H - PAD} L ${x(0)} ${H - PAD} Z`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-16" preserveAspectRatio="none" role="img">
      <path d={area} fill="color-mix(in srgb, var(--color-ok) 12%, transparent)" />
      <path d={d} fill="none" stroke="var(--color-ok)" strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      {series.map((s, i) => (
        <circle key={i} cx={x(i)} cy={y(s.balance)} r={2} fill="var(--color-ok)" />
      ))}
    </svg>
  );
}

/** Monatsbalken: Belohnungen (ok) vs. Strafen (warn) der letzten 6 Monate. */
function MonthBars({ monthly, labels }: { monthly: { key: string; belohnungen: number; strafen: number }[]; labels: { rewards: string; penalties: string } }) {
  const max = Math.max(1, ...monthly.flatMap((m) => [m.belohnungen, m.strafen]));
  return (
    <div>
      <div className="flex items-end gap-2 h-24">
        {monthly.map((m) => (
          <div key={m.key} className="flex-1 flex flex-col items-center gap-1">
            <div className="w-full flex items-end justify-center gap-1 h-20">
              <div
                className="w-1/2 rounded-t-md bg-[var(--color-ok)]"
                style={{ height: `${(m.belohnungen / max) * 100}%`, minHeight: m.belohnungen > 0 ? 4 : 0 }}
                title={`${labels.rewards}: ${m.belohnungen}`}
              />
              <div
                className="w-1/2 rounded-t-md bg-[var(--color-warn)]"
                style={{ height: `${(m.strafen / max) * 100}%`, minHeight: m.strafen > 0 ? 4 : 0 }}
                title={`${labels.penalties}: ${m.strafen}`}
              />
            </div>
            <span className="text-[10px] text-foreground-faint">{m.key.slice(5)}</span>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-center gap-4 mt-2 text-xs text-foreground-muted">
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-[var(--color-ok)]" />{labels.rewards}</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-[var(--color-warn)]" />{labels.penalties}</span>
      </div>
    </div>
  );
}

function Row({ item, title, locale, openLabel }: { item: HistorieItem; title: string; locale: string; openLabel: string }) {
  const style = EVENT_STYLE[item.type] ?? { color: "var(--color-foreground-muted)", Icon: History };
  const { Icon } = style;
  return (
    <li className="flex gap-3 py-3">
      <div
        className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
        style={{ background: `color-mix(in srgb, ${style.color} 14%, transparent)`, color: style.color }}
      >
        <Icon size={16} strokeWidth={2} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium text-foreground">{title}</span>
          {item.delta !== 0 && (
            <span className="text-xs font-bold" style={{ color: item.delta > 0 ? "var(--color-ok)" : "var(--color-warn)" }}>
              {item.delta > 0 ? "+" : ""}{item.delta}
            </span>
          )}
          {item.erledigt === false && (
            <span className="text-[10px] uppercase tracking-wide font-semibold text-[var(--color-warn)]">{openLabel}</span>
          )}
        </div>
        {item.text && <p className="text-xs text-foreground-muted break-words">{item.text}</p>}
        <p className="text-[11px] text-foreground-faint mt-0.5">
          {formatDateTime(item.at, locale)}
          {item.balanceAfter != null && ` · ${item.balanceAfter}`}
        </p>
      </div>
    </li>
  );
}

export default async function HistorieCard({ userId }: { userId: string }) {
  const t = await getTranslations("stats");
  const data = await getHistorie(userId);
  const locale = await getLocale();

  const stats: { label: string; value: number; color?: string }[] = [
    { label: t("histBalance"), value: data.balance, color: "var(--color-ok)" },
    { label: t("histEarned"), value: data.summary.verdient },
    { label: t("histRedeemed"), value: data.summary.eingeloest },
    { label: t("histPenalties"), value: data.summary.strafen, color: data.summary.strafen > 0 ? "var(--color-warn)" : undefined },
  ];

  const titleOf = (i: HistorieItem) => (i.kind === "strafe" ? t(`histType${i.type}`) : t(`histType${i.type}`));
  const hasChart = data.series.length >= 2;
  const hasMonthly = data.monthly.some((m) => m.belohnungen > 0 || m.strafen > 0);

  return (
    <Card>
      <div className="flex items-center gap-2 mb-4">
        <History size={18} className="text-foreground-muted" />
        <h2 className="text-base font-semibold text-foreground">{t("histTitle")}</h2>
      </div>

      <div className="grid grid-cols-4 gap-2 mb-4">
        {stats.map((s) => (
          <div key={s.label} className="rounded-xl bg-surface-raised px-2 py-2.5 text-center">
            <p className="text-lg font-bold" style={s.color ? { color: s.color } : undefined}>{s.value}</p>
            <p className="text-[10px] text-foreground-faint leading-tight mt-0.5">{s.label}</p>
          </div>
        ))}
      </div>

      {hasChart && (
        <div className="mb-4">
          <p className="text-xs font-medium text-foreground-muted mb-1">{t("histBalanceChart")}</p>
          <BalanceChart series={data.series} />
        </div>
      )}

      {hasMonthly && (
        <div className="mb-4">
          <p className="text-xs font-medium text-foreground-muted mb-2">{t("histMonths")}</p>
          <MonthBars monthly={data.monthly} labels={{ rewards: t("histRewardsLegend"), penalties: t("histPenaltiesLegend") }} />
        </div>
      )}

      {data.items.length === 0 ? (
        <EmptyState icon={<History size={28} />} title={t("histEmpty")} description={t("histEmptyHint")} />
      ) : (
        <ul className="divide-y divide-[var(--color-border)]">
          {data.items.map((i) => (
            <Row key={`${i.kind}-${i.id}`} item={i} title={titleOf(i)} locale={locale} openLabel={t("histOpen")} />
          ))}
        </ul>
      )}
    </Card>
  );
}
