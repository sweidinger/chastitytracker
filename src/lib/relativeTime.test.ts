import { describe, it, expect } from "vitest";
import { calendarDaysAgo, relativeDayLabel, relativeTimeLabel, calendarLine } from "./relativeTime";

const TZ = "Europe/Zurich";
/** 21.07.2026, 16:07 Ortszeit (CH = +02:00 im Sommer). */
const now = new Date("2026-07-21T14:07:00.000Z");

describe("calendarDaysAgo — Kalendertage, keine 24h-Bloecke", () => {
  it("derselbe Kalendertag ist 0, auch 16 Stunden frueher", () => {
    expect(calendarDaysAgo(new Date("2026-07-21T00:30:00.000Z"), now, TZ)).toBe(0);
  });

  it("gestern 23:00 Ortszeit ist 1 Tag her — obwohl erst ~17 Stunden vergangen sind", () => {
    // Das ist der Fall, an dem das Modell scheiterte: kurze Spanne, aber anderer Kalendertag.
    expect(calendarDaysAgo(new Date("2026-07-20T21:00:00.000Z"), now, TZ)).toBe(1);
  });

  it("Tagesform-Eintraege werden korrekt eingeordnet (lokale Mitternacht als UTC-Instant)", () => {
    // `datum` speichert die LOKALE Mitternacht: 21.07. CH = 20.07.T22:00Z
    expect(calendarDaysAgo(new Date("2026-07-20T22:00:00.000Z"), now, TZ)).toBe(0);
    expect(calendarDaysAgo(new Date("2026-07-18T22:00:00.000Z"), now, TZ)).toBe(2);
  });
});

describe("relativeDayLabel", () => {
  it("markiert den heutigen Tagesform-Eintrag als HEUTE", () => {
    expect(relativeDayLabel(new Date("2026-07-20T22:00:00.000Z"), now, TZ)).toBe("HEUTE");
  });

  it("nennt den Vortag gestern und aeltere Tage mit Abstand", () => {
    expect(relativeDayLabel(new Date("2026-07-19T22:00:00.000Z"), now, TZ)).toBe("gestern");
    expect(relativeDayLabel(new Date("2026-07-18T22:00:00.000Z"), now, TZ)).toBe("vor 2 Tagen");
  });

  it("kennt auch die Zukunft (geplante Direktiven)", () => {
    expect(relativeDayLabel(new Date("2026-07-21T22:00:00.000Z"), now, TZ)).toBe("morgen");
    expect(relativeDayLabel(new Date("2026-07-23T22:00:00.000Z"), now, TZ)).toBe("in 3 Tagen");
  });
});

describe("relativeTimeLabel — Fristen und Spannen", () => {
  it("Minuten, Singular korrekt", () => {
    expect(relativeTimeLabel(new Date("2026-07-21T14:06:00.000Z"), now, TZ)).toBe("vor 1 Minute");
    expect(relativeTimeLabel(new Date("2026-07-21T14:37:00.000Z"), now, TZ)).toBe("in 30 Minuten");
  });

  it("Stunden bis 48h, danach Kalendertage", () => {
    expect(relativeTimeLabel(new Date("2026-07-21T11:07:00.000Z"), now, TZ)).toBe("vor 3 Stunden");
    expect(relativeTimeLabel(new Date("2026-07-22T06:07:00.000Z"), now, TZ)).toBe("in 16 Stunden");
    expect(relativeTimeLabel(new Date("2026-07-17T14:07:00.000Z"), now, TZ)).toBe("vor 4 Tagen");
  });
});

describe("calendarLine", () => {
  it("nennt Wochentag, heutiges und gestriges Datum", () => {
    const line = calendarLine(now, TZ);
    expect(line).toContain("Dienstag");
    expect(line).toContain("21.07.2026");
    expect(line).toContain("20.07.2026");
  });
});
