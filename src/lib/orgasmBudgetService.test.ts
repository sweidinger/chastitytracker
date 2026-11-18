import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: { user: { findUnique: vi.fn() }, entry: { findMany: vi.fn() } },
}));

import { prisma } from "@/lib/prisma";
import { getOrgasmOverBudgetViolations } from "@/lib/orgasmBudgetService";

const P = prisma as unknown as {
  user: { findUnique: ReturnType<typeof vi.fn> };
  entry: { findMany: ReturnType<typeof vi.fn> };
};

const now = new Date("2026-07-22T12:00:00.000Z"); // Mittwoch
const lastWeek = new Date("2026-07-13T00:00:00.000Z");

function org(id: string, iso: string, art: string | null = "Orgasmus", fulfilled = false) {
  return { id, startTime: new Date(iso), orgasmusArt: art, orgasmusAnforderung: fulfilled ? { fulfilledAt: new Date(iso) } : null };
}

beforeEach(() => vi.clearAllMocks());

describe("getOrgasmOverBudgetViolations", () => {
  it("kein Budget → keine Verstoesse", async () => {
    P.user.findUnique.mockResolvedValue({ orgasmBudget: null, orgasmBudgetPeriode: "WOCHE", orgasmBudgetSetAt: null });
    P.entry.findMany.mockResolvedValue([]);
    expect(await getOrgasmOverBudgetViolations("u", now, "UTC")).toEqual([]);
  });

  it("innerhalb des Limits → keine Verstoesse", async () => {
    P.user.findUnique.mockResolvedValue({ orgasmBudget: 2, orgasmBudgetPeriode: "WOCHE", orgasmBudgetSetAt: lastWeek });
    P.entry.findMany.mockResolvedValue([org("a", "2026-07-20T08:00:00Z"), org("b", "2026-07-21T08:00:00Z")]);
    expect(await getOrgasmOverBudgetViolations("u", now, "UTC")).toEqual([]);
  });

  it("ueber dem Limit → nur der ueberzaehlige zaehlt", async () => {
    P.user.findUnique.mockResolvedValue({ orgasmBudget: 2, orgasmBudgetPeriode: "WOCHE", orgasmBudgetSetAt: lastWeek });
    P.entry.findMany.mockResolvedValue([org("a", "2026-07-20T08:00:00Z"), org("b", "2026-07-21T08:00:00Z"), org("c", "2026-07-22T08:00:00Z")]);
    const v = await getOrgasmOverBudgetViolations("u", now, "UTC");
    expect(v.map((x) => x.entryId)).toEqual(["c"]);
    expect(v[0].used).toBe(3);
    expect(v[0].limit).toBe(2);
  });

  it("feuchter Traum + von Anforderung gedeckte Orgasmen zaehlen nicht", async () => {
    P.user.findUnique.mockResolvedValue({ orgasmBudget: 1, orgasmBudgetPeriode: "WOCHE", orgasmBudgetSetAt: lastWeek });
    P.entry.findMany.mockResolvedValue([
      org("wet", "2026-07-20T08:00:00Z", "feuchter Traum"),
      org("reward", "2026-07-21T08:00:00Z", "Orgasmus", true),
      org("real", "2026-07-22T08:00:00Z"),
    ]);
    expect(await getOrgasmOverBudgetViolations("u", now, "UTC")).toEqual([]);
  });

  it("mitten im Zeitraum gesetztes Budget wirkt nicht rueckwirkend", async () => {
    const setAt = new Date("2026-07-22T06:00:00.000Z");
    P.user.findUnique.mockResolvedValue({ orgasmBudget: 0, orgasmBudgetPeriode: "WOCHE", orgasmBudgetSetAt: setAt });
    P.entry.findMany.mockResolvedValue([
      org("mon", "2026-07-20T08:00:00Z"), org("tue", "2026-07-21T08:00:00Z"), org("wed", "2026-07-22T08:00:00Z"),
    ]);
    const v = await getOrgasmOverBudgetViolations("u", now, "UTC");
    expect(v.map((x) => x.entryId)).toEqual(["wed"]);
  });
});
