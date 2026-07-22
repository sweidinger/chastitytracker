import { describe, it, expect } from "vitest";
import { periodKeyFor } from "./belohnung";

const TZ = "Europe/Zurich";

/** Regression fuer den Monats-Bug: periodKeyFor nutzte tzDateParts().month (0-indexiert) ohne +1,
 *  sodass jeder gespeicherte Key den VORMONAT trug (2026-06-19 fuer den 19. Juli). */
describe("periodKeyFor — Monat 1-indexiert im Key", () => {
  it("day: Juli ist 07, nicht 06", () => {
    expect(periodKeyFor("day", new Date("2026-07-19T12:00:00+02:00"), TZ)).toBe("2026-07-19");
  });
  it("month: Juli ist 07", () => {
    expect(periodKeyFor("month", new Date("2026-07-19T12:00:00+02:00"), TZ)).toBe("2026-07");
  });
  it("year: nur das Jahr", () => {
    expect(periodKeyFor("year", new Date("2026-07-19T12:00:00+02:00"), TZ)).toBe("2026");
  });
  it("Grenzfall Januar -> 01 (nicht 00)", () => {
    expect(periodKeyFor("day", new Date("2026-01-15T12:00:00+01:00"), TZ)).toBe("2026-01-15");
  });
  it("Grenzfall Dezember -> 12", () => {
    expect(periodKeyFor("day", new Date("2026-12-15T12:00:00+01:00"), TZ)).toBe("2026-12-15");
  });
});
