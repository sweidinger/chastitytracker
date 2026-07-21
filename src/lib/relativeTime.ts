import { APP_TZ, midnightInTZ } from "@/lib/utils";

/**
 * Relative Zeitangaben für die KI-Prompts.
 *
 * WARUM es das gibt: `TIME_GUIDANCE` verbietet der Keyholderin, Uhrzeiten und Restdauern selbst
 * zu rechnen — lieferte ihr aber nur nackte Datumsangaben („2026-07-21"). Damit hatte das Verbot
 * kein Gegenstück: Sie MUSSTE rechnen, um zu wissen, wie lange etwas her ist, tat es falsch und
 * erklärte das Ergebnis anschliessend mit einem erfundenen „Sync-Verzug". Diese Funktionen legen
 * ihr die Spanne fertig hin, damit „rechne nicht selbst" befolgbar wird.
 *
 * Alles rechnet in KALENDERTAGEN der Zeitzone des Subs, nicht in 24-Stunden-Blöcken: Ein Eintrag
 * von gestern 23:00 ist „gestern", auch wenn erst zwei Stunden vergangen sind. Die Verwechslung
 * von Kalendertag und Zeitspanne war genau der beobachtete Fehler.
 */

/** Kalendertage zwischen zwei Zeitpunkten in `tz`. Positiv = `d` liegt vor `now` (Vergangenheit). */
export function calendarDaysAgo(d: Date, now: Date, tz: string = APP_TZ): number {
  const dayMs = 86_400_000;
  const a = midnightInTZ(d, tz).getTime();
  const b = midnightInTZ(now, tz).getTime();
  return Math.round((b - a) / dayMs);
}

/** Deutsche Pluralform ohne Bibliothek — nur die Einheiten, die hier vorkommen. */
function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Tages-Label für ein Datum ohne relevante Uhrzeit (Tagesform, Kalendertage).
 * „HEUTE" ist bewusst versal — es ist die Angabe, die im Prompt am häufigsten überlesen wurde.
 */
export function relativeDayLabel(d: Date, now: Date, tz: string = APP_TZ): string {
  const days = calendarDaysAgo(d, now, tz);
  if (days === 0) return "HEUTE";
  if (days === 1) return "gestern";
  if (days === -1) return "morgen";
  if (days > 1) return `vor ${plural(days, "Tag", "Tagen")}`;
  return `in ${plural(-days, "Tag", "Tagen")}`;
}

/**
 * Spannen-Label für Zeitpunkte MIT Uhrzeit (Fristen, Sperr-Enden, letzter Orgasmus).
 * Unter einer Stunde in Minuten, bis zwei Tage in Stunden, darüber in Kalendertagen — die
 * Auflösung, in der die Keyholderin auch argumentiert.
 */
export function relativeTimeLabel(d: Date, now: Date, tz: string = APP_TZ): string {
  const diffMs = now.getTime() - d.getTime();
  const past = diffMs >= 0;
  const abs = Math.abs(diffMs);
  const minutes = Math.round(abs / 60_000);

  if (minutes < 1) return "gerade eben";
  if (minutes < 60) {
    return past ? `vor ${plural(minutes, "Minute", "Minuten")}` : `in ${plural(minutes, "Minute", "Minuten")}`;
  }
  const hours = Math.round(abs / 3_600_000);
  if (hours < 48) {
    return past ? `vor ${plural(hours, "Stunde", "Stunden")}` : `in ${plural(hours, "Stunde", "Stunden")}`;
  }
  return relativeDayLabel(d, now, tz);
}

/** Hängt das Relativ-Label in Klammern an eine bereits formatierte Zeitangabe. */
export function withRelative(formatted: string, d: Date, now: Date, tz: string = APP_TZ): string {
  return `${formatted} (${relativeTimeLabel(d, now, tz)})`;
}

/**
 * Kalender-Zeile für den Systemprompt. Nennt Wochentag, heutiges Datum und ausdrücklich das
 * Datum von gestern — die Verwechslung „gestriger Eintrag" vs. „heutiger Eintrag" war der
 * konkrete Anlass. Der Tageswechsel steht damit in jedem Prompt, ohne dass ihn jemand melden muss.
 */
export function calendarLine(now: Date, tz: string = APP_TZ): string {
  const fmt = (d: Date, opts: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("de-CH", { timeZone: tz, ...opts }).format(d);
  // Mittag des Vortags statt Mitternacht minus 1 ms: robust gegen Sommerzeit-Wechsel.
  const gestern = new Date(midnightInTZ(now, tz).getTime() - 43_200_000);
  return (
    `KALENDER: Heute ist ${fmt(now, { weekday: "long" })}, der ${fmt(now, { day: "2-digit", month: "2-digit", year: "numeric" })}. ` +
    `Gestern war der ${fmt(gestern, { day: "2-digit", month: "2-digit", year: "numeric" })}. ` +
    `Ein Datum mit dem heutigen Tag ist AKTUELL, nicht veraltet.`
  );
}
