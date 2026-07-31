import { describe, it, expect } from "vitest";
import { normalizeUid, canonicalUid, parseNdef } from "./uid";

describe("normalizeUid", () => {
  it("entfernt Trenner und macht Grossbuchstaben, ohne die Reihenfolge zu drehen", () => {
    expect(normalizeUid("04:a1:b2:c3:d4:e5:80")).toBe("04A1B2C3D4E580");
    expect(normalizeUid("04a1b2c3d4e580")).toBe("04A1B2C3D4E580");
    expect(normalizeUid("04 A1 B2 C3")).toBe("04A1B2C3");
  });

  it("wirft bei zu kurzer, zu langer oder ungerader UID", () => {
    expect(() => normalizeUid("04A1B2")).toThrow(); // 6 Hex < 8
    expect(() => normalizeUid("04A1B2C3D4E5F6A7B8C9D0")).toThrow(); // 22 Hex > 20
    expect(() => normalizeUid("04A1B2C3D")).toThrow(); // 9 Hex, ungerade
    expect(() => normalizeUid("")).toThrow();
  });
});

describe("canonicalUid", () => {
  it("lässt eine mit 04 beginnende UID unverändert", () => {
    expect(canonicalUid("04:A1:B2:C3:D4:E5:80")).toBe("04A1B2C3D4E580");
  });

  it("dreht eine gedrehte (iOS) UID zurück auf 04-zuerst", () => {
    // 04A1B2C3D4E580 rückwärts (byteweise) = 80E5D4C3B2A104
    expect(canonicalUid("80E5D4C3B2A104")).toBe("04A1B2C3D4E580");
    expect(canonicalUid("80:E5:D4:C3:B2:A1:04")).toBe("04A1B2C3D4E580");
  });

  it("ist idempotent für eine bereits kanonische UID", () => {
    const c = canonicalUid("04A1B2C3D4E580");
    expect(canonicalUid(c)).toBe(c);
  });
});

describe("parseNdef", () => {
  it("zerlegt einen gültigen AL1-Record", () => {
    expect(parseNdef("AL1|12345|deadbeefdeadbeefdeadbeefdeadbeef")).toEqual({
      code: "12345",
      token: "deadbeefdeadbeefdeadbeefdeadbeef",
    });
  });

  it("trimmt Whitespace um den Record", () => {
    expect(parseNdef("  AL1|12345|abcd  ")).toEqual({ code: "12345", token: "abcd" });
  });

  it("gibt null bei falschem Präfix oder falscher Teilezahl zurück", () => {
    expect(parseNdef("XX1|12345|abcd")).toBeNull();
    expect(parseNdef("AL1|12345")).toBeNull();
    expect(parseNdef("AL1|1|2|3")).toBeNull();
    expect(parseNdef("")).toBeNull();
  });
});
