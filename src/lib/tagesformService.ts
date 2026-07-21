import { prisma } from "@/lib/prisma";
import { getUserTimezone } from "@/lib/queries";
import { APP_TZ } from "@/lib/utils";
import { relativeDayLabel } from "@/lib/relativeTime";

/** Ein Tagesform-Eintrag, wie ihn die KI/der MCP sieht. Werte 1–5 (1 = kaum, 5 = extrem). */
export interface TagesformRow {
  /** Kalendertag YYYY-MM-DD in der Zeitzone des Users. */
  datum: string;
  /** „HEUTE" | „gestern" | „vor N Tagen" — damit die KI den Abstand nicht selbst herleiten muss. */
  relativ: string;
  /** Erregung / Frustration durch die Keuschheit. */
  erregung: number;
  /** Körperliches Wohlbefinden / Tragekomfort. */
  koerper: number;
  /** Mentale Verfassung / sub-space-Tiefe. */
  headspace: number;
  notiz: string | null;
}

/** Tagesform-Block des Overviews: die letzten Tage + die daraus abgeleiteten Verhaltensregeln. */
export interface TagesformView {
  /** Ob fuer den heutigen Kalendertag (Zeitzone des Subs) bereits ein Eintrag existiert. */
  heuteErfasst: boolean;
  /** Jüngster Eintrag zuerst. Leer = der User hat (noch) nichts erfasst. */
  eintraege: TagesformRow[];
  /** Ableitung aus dem JÜNGSTEN Eintrag. Verbindlich für die KI-Keyholderin. */
  regeln: string[];
}

/** Wie viele Tage Tagesform-Historie in den Kontext wandern. */
export const TAGESFORM_DAYS = 3;

/** `datum` ist der UTC-Instant der LOKALEN Mitternacht. Wird er mit toISOString() formatiert,
 *  kippt er bei positivem Offset (z. B. CH = +02:00) auf den Vortag. Deshalb immer in der
 *  Zeitzone des Users rendern. */
function formatTagesformDatum(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** Verhaltensregeln aus der aktuellsten Tagesform. Fürsorge schlägt Strenge. */
export function tagesformRegeln(latest: TagesformRow): string[] {
  const regeln: string[] = [];
  if (latest.koerper <= 2)
    regeln.push("⚠ Körperliches Wohlbefinden niedrig (≤2) — KEINE create_sperrzeit und KEIN Einschluss-Druck. Fürsorge hat Vorrang.");
  if (latest.erregung >= 4)
    regeln.push("✓ Erregung/Frustration hoch (≥4) — Gute Gelegenheit für Aufgaben, Verlängerungen oder Plug-Anforderungen.");
  if (latest.headspace <= 1)
    regeln.push("⚠ Mentale Verfassung sehr niedrig (1) — Sanfter Ton, keine Strafen, keine neuen Anforderungen. Zeige Verständnis.");
  return regeln;
}

/** Lädt die Tagesform der letzten `days` Tage und leitet die Verhaltensregeln ab. */
export async function buildTagesformView(
  userId: string,
  tz: string = APP_TZ,
  days: number = TAGESFORM_DAYS,
  now: Date = new Date(),
): Promise<TagesformView> {
  const since = new Date(now.getTime() - days * 86_400_000);
  const rows = await prisma.tagesform.findMany({
    where: { userId, datum: { gte: since } },
    orderBy: { datum: "desc" },
    select: { datum: true, erregung: true, koerper: true, headspace: true, notiz: true },
  });

  const eintraege: TagesformRow[] = rows.map((tf) => ({
    datum: formatTagesformDatum(tf.datum, tz),
    relativ: relativeDayLabel(tf.datum, now, tz),
    erregung: tf.erregung,
    koerper: tf.koerper,
    headspace: tf.headspace,
    notiz: tf.notiz,
  }));

  return {
    eintraege,
    heuteErfasst: eintraege.some((e) => e.relativ === "HEUTE"),
    regeln: eintraege.length > 0 ? tagesformRegeln(eintraege[0]) : [],
  };
}

/** Prompt-Block für die KI-Keyholderin. "" wenn keine Tagesform erfasst ist — dann (und NUR dann)
 *  darf sie danach fragen. */
export function tagesformPromptText(view: TagesformView): string {
  if (view.eintraege.length === 0) return "";
  const rows = view.eintraege.map((tf) => {
    const notizPart = tf.notiz ? ` | Notiz: "${tf.notiz}"` : "";
    return `  ${tf.datum} (${tf.relativ}): 🔥 Erregung ${tf.erregung}/5 · 💪 Körper ${tf.koerper}/5 · 🧠 Headspace ${tf.headspace}/5${notizPart}`;
  });
  return (
    "\n\n--- Tagesform des Users (letzte Tage) ---\n" +
    rows.join("\n") +
    (view.heuteErfasst
      ? "\nDie Tagesform für HEUTE liegt vor (oben mit „HEUTE“ markiert) — FRAGE NICHT danach, sondern nutze sie."
      : "\nFür HEUTE ist noch keine Tagesform erfasst — hier darfst (und sollst) du danach fragen. Die älteren Werte oben sind NICHT der heutige Stand.") +
    (view.regeln.length > 0
      ? "\n\nVerhaltensregeln basierend auf aktueller Tagesform:\n" + view.regeln.join("\n")
      : "")
  );
}

/** Bequemer One-Shot für die Prompt-Pfade: lädt + rendert. Nie fatal — im Fehlerfall "". */
export async function buildTagesformContext(userId: string, tz?: string): Promise<string> {
  try {
    const zone = tz ?? (await getUserTimezone(userId));
    return tagesformPromptText(await buildTagesformView(userId, zone));
  } catch {
    return "";
  }
}
