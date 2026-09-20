import { describe, it, expect } from "vitest";
import { classifyChildren5to17y, classifyAdult, nacsMuacBand5to17y, worstAcuteClassification } from "../nacsClassificationTools.js";

/**
 * classifyChildren5to17y / classifyAdult were extracted from the nacs_classify_children_5_17y and
 * nacs_classify_adult tool handlers so the new screening modules can reuse them in-process.
 * These pin the original behaviour so the extraction stays a pure refactor.
 */
describe("classifyChildren5to17y (extracted from nacs_classify_children_5_17y)", () => {
  it("throws with the original messages", () => {
    expect(() => classifyChildren5to17y({})).toThrow(/at least one of edema, muac_mm, or bmi_for_age_z/);
    expect(() => classifyChildren5to17y({ muac_mm: 150 })).toThrow(/age_years is required/);
  });

  it("MUAC bands", () => {
    expect(nacsMuacBand5to17y(5)).toEqual({ severe: 135, moderate: 145, label: "5-9 years" });
    expect(nacsMuacBand5to17y(9.99).label).toBe("5-9 years");
    expect(nacsMuacBand5to17y(10).label).toBe("10-14 years");
    expect(nacsMuacBand5to17y(15).label).toBe("15-17 years");
  });

  it("BMI-for-age z cut-offs: < -3 severe, < -2 moderate, <= +1 normal, <= +2 overweight, > +2 obesity", () => {
    const cls = (z: number) => classifyChildren5to17y({ bmi_for_age_z: z }).indicators[0].classification;
    expect(cls(-3.01)).toBe("severe");
    expect(cls(-3)).toBe("moderate");
    expect(cls(-2)).toBe("normal");
    expect(cls(1)).toBe("normal");
    expect(cls(1.01)).toBe("overweight");
    expect(cls(2)).toBe("overweight");
    expect(cls(2.01)).toBe("obesity");
  });

  it("keeps the original result shape", () => {
    const r = classifyChildren5to17y({ age_years: 8, edema: true });
    expect(r.ageGroup).toBe("5-17 years");
    expect(r.overallMalnutritionClassification).toBe("severe");
    expect(r.note).toMatch(/Weight loss >5%/);
  });
});

describe("classifyAdult (extracted from nacs_classify_adult)", () => {
  it("throws with the original message when nothing is provided", () => {
    expect(() => classifyAdult({})).toThrow(/at least one of edema, muac_mm, bmi, or confirmed_weight_loss_over_10_percent/);
  });

  it("classifies and reports the original population label", () => {
    const r = classifyAdult({ muac_mm: 200, bmi: 17 });
    expect(r.population).toBe("adults 18+ (non-pregnant/non-postpartum)");
    expect(r.indicators.map((i) => i.classification)).toEqual(["moderate", "moderate"]);
    expect(r.overallMalnutritionClassification).toBe("moderate");
  });

  it("overweight/obesity never override a moderate/severe finding", () => {
    expect(worstAcuteClassification(classifyAdult({ muac_mm: 200, bmi: 32 }).indicators)).toBe("moderate");
  });
});
