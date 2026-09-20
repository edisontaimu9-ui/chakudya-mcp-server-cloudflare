import { describe, it, expect } from "vitest";
import { estimateWeightPersons65Plus, estimateWeightFromKneeHeightAndMac } from "../weightEstimationTools.js";

describe("estimateWeightPersons65Plus (Lee & Nieman, 65+)", () => {
  it("female MUAC + calf: (27.5 x 1.63) + (31.5 x 1.43) - 37.46 = 52.41, SEE 4.96", () => {
    const [e] = estimateWeightPersons65Plus("female", { muac: 27.5, cc: 31.5 });
    expect(e.estimated_weight_kg).toBeCloseTo(52.41, 2);
    expect(e.see_kg).toBe(4.96);
    expect(e.inputs_used).toEqual(["muac", "cc"]);
  });

  it("male MUAC + calf: (26.5 x 2.31) + (31 x 1.50) - 50.10 = 57.615, SEE 5.37", () => {
    const [e] = estimateWeightPersons65Plus("male", { muac: 26.5, cc: 31 });
    expect(e.estimated_weight_kg).toBeCloseTo(57.615, 1);
    expect(e.see_kg).toBe(5.37);
  });

  it("returns more equations as more measurements are given, most precise (lowest SEE) first", () => {
    const two = estimateWeightPersons65Plus("female", { muac: 27.5, cc: 31.5 });
    const three = estimateWeightPersons65Plus("female", { muac: 27.5, cc: 31.5, ssf: 12 });
    const four = estimateWeightPersons65Plus("female", { muac: 27.5, cc: 31.5, ssf: 12, kh: 50 });
    expect(two).toHaveLength(1);
    expect(three).toHaveLength(2);
    expect(four).toHaveLength(3);
    for (const list of [three, four]) {
      const sees = list.map((e) => e.see_kg);
      expect(sees).toEqual([...sees].sort((a, b) => a - b));
    }
    expect(four[0].see_kg).toBe(3.8);
  });

  it("gives nothing when MUAC and calf are not both present, and never uses knee height without a skinfold", () => {
    expect(estimateWeightPersons65Plus("male", { muac: 26 })).toHaveLength(0);
    expect(estimateWeightPersons65Plus("male", { cc: 31 })).toHaveLength(0);
    expect(estimateWeightPersons65Plus("male", { muac: 26, cc: 31, kh: 50 })).toHaveLength(1);
  });
});

describe("estimateWeightFromKneeHeightAndMac (Lee & Nieman, 6-80, race-specific)", () => {
  it("black male 19-59: (50 x 1.09) + (30 x 3.14) - 83.72 = 64.98, SEE 11.3", () => {
    const r = estimateWeightFromKneeHeightAndMac({ sex: "male", race: "black", age_years: 40, knee_height_cm: 50, mid_arm_circumference_cm: 30 });
    expect(r.ok && r.estimated_weight_kg).toBeCloseTo(64.98, 2);
    expect(r.ok && r.see_kg).toBe(11.3);
    expect(r.ok && r.age_band).toBe("19-59");
  });

  it("uses the age band that matches: 6-18, 19-59, 60-80", () => {
    const band = (age: number) => {
      const r = estimateWeightFromKneeHeightAndMac({ sex: "female", race: "white", age_years: age, knee_height_cm: 45, mid_arm_circumference_cm: 26 });
      return r.ok ? r.age_band : null;
    };
    expect(band(6)).toBe("6-18");
    expect(band(18)).toBe("6-18");
    expect(band(19)).toBe("19-59");
    expect(band(59)).toBe("19-59");
    expect(band(60)).toBe("60-80");
    expect(band(80)).toBe("60-80");
  });

  it("refuses ages outside 6-80 and the gaps between bands, rather than guessing", () => {
    for (const age of [5, 18.5, 59.5, 81]) {
      const r = estimateWeightFromKneeHeightAndMac({ sex: "male", race: "black", age_years: age, knee_height_cm: 50, mid_arm_circumference_cm: 30 });
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error).toMatch(/No matching equation/);
    }
  });

  it("its standard errors are large for adults (about 7-14.5 kg) — the reason callers must show them", () => {
    const see = (sex: "male" | "female", race: "black" | "white") => {
      const r = estimateWeightFromKneeHeightAndMac({ sex, race, age_years: 40, knee_height_cm: 50, mid_arm_circumference_cm: 28 });
      return r.ok ? r.see_kg : NaN;
    };
    for (const sex of ["male", "female"] as const) for (const race of ["black", "white"] as const) expect(see(sex, race)).toBeGreaterThan(10);
  });
});
