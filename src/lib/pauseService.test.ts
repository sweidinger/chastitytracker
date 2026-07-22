import { describe, it, expect } from "vitest";
import { buildCagePauseQuota, type CagePauseUserFields, type PauseGrund } from "./pauseService";

function user(overrides: Partial<CagePauseUserFields> = {}): CagePauseUserFields {
  return {
    reinigungErlaubt: true, reinigungMaxMinuten: 15, reinigungMaxProTag: 5,
    toiletteErlaubt: true, toiletteMaxMinuten: 15, toiletteMaxProTag: 5,
    ...overrides,
  };
}

function counts(overrides: Partial<Record<PauseGrund, number>> = {}): Record<PauseGrund, number> {
  return { REINIGUNG: 0, TOILETTE: 0, ...overrides };
}

describe("buildCagePauseQuota", () => {
  it("liefert Rest = Limit - genutzt für beide erlaubten Arten", () => {
    const q = buildCagePauseQuota(user(), counts({ REINIGUNG: 2, TOILETTE: 1 }));
    expect(q).toEqual([
      { grund: "REINIGUNG", used: 2, max: 5, remaining: 3 },
      { grund: "TOILETTE", used: 1, max: 5, remaining: 4 },
    ]);
  });

  it("blendet deaktivierte Pausen-Arten aus", () => {
    const q = buildCagePauseQuota(user({ toiletteErlaubt: false }), counts({ REINIGUNG: 1 }));
    expect(q.map((e) => e.grund)).toEqual(["REINIGUNG"]);
  });

  it("gibt bei Limit 0 (unbegrenzt) remaining = null", () => {
    const q = buildCagePauseQuota(user({ reinigungMaxProTag: 0 }), counts({ REINIGUNG: 9 }));
    expect(q[0]).toEqual({ grund: "REINIGUNG", used: 9, max: 0, remaining: null });
  });

  it("clampt remaining nie ins Negative (Überschreitung → 0)", () => {
    const q = buildCagePauseQuota(user({ toiletteErlaubt: false }), counts({ REINIGUNG: 7 }));
    expect(q[0].remaining).toBe(0);
  });

  it("liefert leere Liste, wenn keine Pausen-Art erlaubt ist", () => {
    const q = buildCagePauseQuota(user({ reinigungErlaubt: false, toiletteErlaubt: false }), counts());
    expect(q).toEqual([]);
  });
});
