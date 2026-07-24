import { describe, it, expect } from "vitest";
import { moodBand, decayedMood, effectiveMood, moodDeltaForAction, moodHintForSub, MOOD_NEUTRAL } from "./moodService";

describe("moodService", () => {
  it("bands decken den Bereich ab", () => {
    expect(moodBand(10).key).toBe("frostig");
    expect(moodBand(30).key).toBe("unzufrieden");
    expect(moodBand(50).key).toBe("neutral");
    expect(moodBand(70).key).toBe("zufrieden");
    expect(moodBand(90).key).toBe("zaertlich");
  });

  it("neutral bleibt neutral", () => {
    expect(MOOD_NEUTRAL).toBe(50);
    expect(decayedMood(50, new Date("2026-07-01T00:00:00Z"), new Date("2026-07-10T00:00:00Z"))).toBe(50);
  });

  it("Zerfall zieht Richtung neutral (nie darueber hinaus)", () => {
    const upd = new Date("2026-07-20T00:00:00Z");
    const now = new Date("2026-07-24T00:00:00Z"); // 4 Tage -> 12 Punkte
    expect(decayedMood(80, upd, now)).toBe(68); // 80 - 12
    expect(decayedMood(20, upd, now)).toBe(32); // 20 + 12
    // sehr lange her -> genau neutral, nicht drueber
    const long = new Date("2026-01-01T00:00:00Z");
    expect(decayedMood(90, long, now)).toBe(50);
    expect(decayedMood(10, long, now)).toBe(50);
  });

  it("ohne updatedAt kein Zerfall", () => {
    expect(decayedMood(80, null, new Date())).toBe(80);
  });

  it("effectiveMood rundet", () => {
    expect(effectiveMood({ moodScore: 80, moodUpdatedAt: null })).toBe(80);
  });

  it("Deltas: Strafe negativ, Belohnung positiv", () => {
    expect(moodDeltaForAction("create_strafe")).toBeLessThan(0);
    expect(moodDeltaForAction("grant_reward")).toBeGreaterThan(0);
    expect(moodDeltaForAction("credit_reward")).toBeGreaterThan(0);
    expect(moodDeltaForAction("send_message")).toBe(0);
    expect(moodDeltaForAction(null)).toBe(0);
  });

  it("Sub-Hinweis passt zur Stimmung", () => {
    expect(moodHintForSub({ moodScore: 90, moodUpdatedAt: null })).toContain("zufrieden");
    expect(moodHintForSub({ moodScore: 10, moodUpdatedAt: null })).toContain("kühl");
  });
});
