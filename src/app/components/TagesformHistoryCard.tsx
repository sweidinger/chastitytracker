import { prisma } from "@/lib/prisma";
import { tzDateParts } from "@/lib/utils";
import Card from "./Card";

/**
 * Fork: Tagesform – 14-Tage-Verlauf (Erregung / Körper / Headspace) auf der Statistik-Seite.
 *
 * Lädt sich selbst und gibt `null` zurück, wenn im Zeitraum nichts erfasst wurde — passt damit als
 * eigener Block in Upstreams Statistik-Stapel (`statsBlocks.tsx`, Id `tagesform`).
 */
const HISTORY_DAYS = 14;
const DAY_MS = 86_400_000;

type TagesformDay = { key: string; erregung: number | null; koerper: number | null; headspace: number | null };

export default async function TagesformHistoryCard({ userId, now, tz, title }: {
  userId: string;
  now: Date;
  /** Zone des Trägers — bestimmt, welcher Kalendertag ein Eintrag ist. */
  tz: string;
  title: string;
}) {
  const since = new Date(now.getTime() - HISTORY_DAYS * DAY_MS);
  const tagesformen = await prisma.tagesform.findMany({
    where: { userId, datum: { gte: since } },
    orderBy: { datum: "asc" },
    select: { datum: true, erregung: true, koerper: true, headspace: true },
  });
  if (tagesformen.length === 0) return null;

  const dayKey = (d: Date) => {
    const { year, month, day } = tzDateParts(d, tz);
    return `${year}-${month}-${day}`;
  };
  const byKey = new Map(tagesformen.map((tf) => [dayKey(tf.datum), tf]));
  const days: TagesformDay[] = Array.from({ length: HISTORY_DAYS }, (_, i) => {
    const key = dayKey(new Date(now.getTime() - (HISTORY_DAYS - 1 - i) * DAY_MS));
    const tf = byKey.get(key);
    return { key, erregung: tf?.erregung ?? null, koerper: tf?.koerper ?? null, headspace: tf?.headspace ?? null };
  });

  return (
    <Card padding="none" className="overflow-hidden">
      <div className="px-6 py-4 border-b border-border-subtle">
        <p className="text-sm font-bold text-foreground">{title}</p>
      </div>
      <div className="px-5 py-4 overflow-x-auto">
        <TagesformHistory days={days} />
      </div>
    </Card>
  );
}

const TAGESFORM_DIMS = [
  { key: "erregung" as const, emoji: "🔥" },
  { key: "koerper" as const, emoji: "💪" },
  { key: "headspace" as const, emoji: "🧠" },
];

/** Color for a value 1–5; null = no entry (grey). */
function tagesformColor(value: number | null): string {
  if (value === null) return "bg-border";
  if (value <= 1) return "bg-blue-200";
  if (value <= 2) return "bg-blue-300";
  if (value <= 3) return "bg-blue-400";
  if (value <= 4) return "bg-blue-500";
  return "bg-blue-600";
}

function TagesformHistory({ days }: { days: TagesformDay[] }) {
  return (
    <div className="flex flex-col gap-2.5">
      {TAGESFORM_DIMS.map(({ key, emoji }) => (
        <div key={key} className="flex items-center gap-2">
          <span className="text-sm w-5 text-center shrink-0" aria-hidden>{emoji}</span>
          <div className="flex gap-1">
            {days.map((d) => (
              <div
                key={d.key}
                title={d[key] !== null ? `${d.key}: ${d[key]}/5` : d.key}
                className={`w-4 h-4 rounded-sm transition-colors ${tagesformColor(d[key])}`}
              />
            ))}
          </div>
        </div>
      ))}
      {/* Day axis: show day-of-month for every other column */}
      <div className="flex items-center gap-2 mt-0.5">
        <span className="w-5 shrink-0" />
        <div className="flex gap-1">
          {days.map((d, i) => (
            <div key={d.key} className="w-4 flex justify-center">
              {i % 2 === 0 ? (
                <span className="text-[9px] text-foreground-faint tabular-nums leading-none">{Number(d.key.split("-")[2])}</span>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
