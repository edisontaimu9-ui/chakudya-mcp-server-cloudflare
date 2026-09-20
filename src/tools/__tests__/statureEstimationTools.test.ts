import { describe, it, expect } from "vitest";
import { estimateStatureFromUlna, estimateStatureFromKneeHeight } from "../statureEstimationTools.js";

describe("estimateStatureFromUlna", () => {
  it("looks up the table by sex and age band (<65 / >=65)", () => {
    const m = estimateStatureFromUlna("male", 40, 26.0);
    expect(m.ok && m.estimated_height_cm).toBe(173);
    const f = estimateStatureFromUlna("female", 70, 26.0);
    expect(f.ok && f.estimated_height_cm).toBe(165);
  });

  it("switches age band at exactly 65", () => {
    const under = estimateStatureFromUlna("male", 64.9, 26.0);
    const over = estimateStatureFromUlna("male", 65, 26.0);
    expect(under.ok && under.estimated_height_cm).toBe(173);
    expect(over.ok && over.estimated_height_cm).toBe(168);
  });

  it("rounds the ulna length to the nearest 0.5 cm table row", () => {
    const r = estimateStatureFromUlna("male", 40, 26.3);
    expect(r.ok && r.detail.matched_table_ulna_cm).toBe(26.5);
    expect(r.ok && r.estimated_height_cm).toBe(175);
  });

  it("covers the table ends and rejects values outside 18.5-32.0", () => {
    expect(estimateStatureFromUlna("male", 40, 18.5).ok).toBe(true);
    expect(estimateStatureFromUlna("male", 40, 32.0).ok).toBe(true);
    expect(estimateStatureFromUlna("male", 40, 33).ok).toBe(false);
    expect(estimateStatureFromUlna("male", 40, 17).ok).toBe(false);
  });

  it("marks the doubtful men >=65 / 30.0 cm cell as unreliable, and only that cell", () => {
    const bad = estimateStatureFromUlna("male", 70, 30.0);
    expect(bad.ok && bad.unreliable_reason).toMatch(/print\/scan error/);
    const fine = estimateStatureFromUlna("male", 70, 30.5);
    expect(fine.ok && fine.unreliable_reason).toBeUndefined();
    const otherSex = estimateStatureFromUlna("female", 70, 30.0);
    expect(otherSex.ok && otherSex.unreliable_reason).toBeUndefined();
    const younger = estimateStatureFromUlna("male", 60, 30.0);
    expect(younger.ok && younger.unreliable_reason).toBeUndefined();
  });

  it("publishes no error figure for the ulna table", () => {
    const r = estimateStatureFromUlna("male", 40, 26.0);
    expect(r.ok && r.error_cm).toBeUndefined();
  });
});

describe("estimateStatureFromKneeHeight (Lee & Nieman)", () => {
  it("black male 19-60: 73.42 + 1.79 x KH, error 7.2 cm", () => {
    const r = estimateStatureFromKneeHeight("black", "male", 40, 50);
    expect(r.ok && r.estimated_height_cm).toBeCloseTo(162.92, 2);
    expect(r.ok && r.error_cm).toBe(7.2);
  });

  it("black female > 60: 58.72 + 1.96 x KH, error 8.26 cm", () => {
    const r = estimateStatureFromKneeHeight("black", "female", 61, 45);
    expect(r.ok && r.estimated_height_cm).toBeCloseTo(146.92, 2);
    expect(r.ok && r.error_cm).toBe(8.26);
  });

  it("uses the 19-60 band at exactly 60 and the >60 band above it", () => {
    const at60 = estimateStatureFromKneeHeight("black", "female", 60, 45);
    const above = estimateStatureFromKneeHeight("black", "female", 60.5, 45);
    expect(at60.ok && at60.detail.age_band).toBe("19-60");
    expect(above.ok && above.detail.age_band).toBe("> 60");
  });

  it("has no equation between 18 and 19 years — refuses rather than guessing", () => {
    const r = estimateStatureFromKneeHeight("black", "male", 18.5, 50);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/No matching equation/);
  });
});
