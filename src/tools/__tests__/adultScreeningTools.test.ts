import { describe, it, expect } from "vitest";
import { integratedAdultScreen, mustScreen } from "../adultScreeningTools.js";

const run = (input: Parameters<typeof integratedAdultScreen>[0]) => {
  const r = integratedAdultScreen(input);
  if (!r.ok) throw new Error(r.error);
  return r.result;
};
const indicator = (r: ReturnType<typeof run>, name: string) => r.nacs_classification?.indicators.find((i) => i.indicator === name);

describe("integratedAdultScreen — scope and validation", () => {
  it("declines a pregnant/postpartum woman and points to the maternal tool", () => {
    const r = integratedAdultScreen({ sex: "female", age: { age_years: 28 }, muac_mm: 240, pregnant_or_postpartum: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/pregnant_postpartum_integrated_screen/);
  });

  it("rejects under-18s and points to the school-age tool", () => {
    const r = integratedAdultScreen({ sex: "male", age: { age_months: 215 }, muac_mm: 250 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/school_age_integrated_screen/);
  });

  it("accepts exactly 18 years", () => {
    expect(integratedAdultScreen({ sex: "male", age: { age_years: 18 }, muac_mm: 250 }).ok).toBe(true);
  });

  it("requires an age", () => {
    expect(integratedAdultScreen({ sex: "male", age: {}, muac_mm: 250 }).ok).toBe(false);
  });

  it("rejects a non-positive BMI", () => {
    expect(integratedAdultScreen({ sex: "male", age: { age_years: 30 }, bmi: 0 }).ok).toBe(false);
  });
});

describe("integratedAdultScreen — NACS adult cut-offs (reused engine)", () => {
  it("MUAC: 184 severe, 185 moderate, 219 moderate, 220 normal", () => {
    const cls = (muac: number) => indicator(run({ sex: "male", age: { age_years: 40 }, muac_mm: muac }), "muac")?.classification;
    expect(cls(184)).toBe("severe");
    expect(cls(185)).toBe("moderate");
    expect(cls(219)).toBe("moderate");
    expect(cls(220)).toBe("normal");
  });

  it("BMI from weight+height: 15.9 severe, 16.0 moderate, 18.5 normal, 25.0 overweight, 30.0 obesity", () => {
    const cls = (bmi: number) => indicator(run({ sex: "female", age: { age_years: 40 }, bmi }), "bmi")?.classification;
    expect(cls(15.9)).toBe("severe");
    expect(cls(16.0)).toBe("moderate");
    expect(cls(18.5)).toBe("normal");
    expect(cls(25.0)).toBe("overweight");
    expect(cls(30.0)).toBe("obesity");
  });

  it("uses the UNROUNDED BMI (53.4 kg / 170 cm = 18.477 is moderate; rounding to 18.5 first would wrongly make it normal)", () => {
    const r = run({ sex: "female", age: { age_years: 40 }, weight_kg: 53.4, height_cm: 170 });
    expect(indicator(r, "bmi")?.classification).toBe("moderate");
    expect(r.measurements.bmi).toBe(18.5); // displayed rounded, classified unrounded
    expect(indicator(r, "bmi")?.value).toBe("18.5");
  });

  it("oedema alone is severe -> urgent", () => {
    const r = run({ sex: "male", age: { age_years: 40 }, edema: true, muac_mm: 300, bmi: 22 });
    expect(r.risk.anthropometric_malnutrition_status).toBe("severe");
    expect(r.recommended_action.urgency).toBe("urgent");
  });

  it("confirmed >10% weight loss alone is severe -> urgent", () => {
    const r = run({ sex: "male", age: { age_years: 40 }, confirmed_weight_loss_over_10_percent: true, bmi: 22 });
    expect(r.recommended_action.urgency).toBe("urgent");
  });

  it("moderate -> priority; normal -> routine", () => {
    expect(run({ sex: "male", age: { age_years: 40 }, muac_mm: 200 }).recommended_action.urgency).toBe("priority");
    expect(run({ sex: "male", age: { age_years: 40 }, muac_mm: 260, bmi: 22, edema: false, confirmed_weight_loss_over_10_percent: false }).recommended_action.urgency).toBe("routine");
  });

  it("overweight/obesity is routine counselling, and never reads as acute malnutrition", () => {
    const r = run({ sex: "female", age: { age_years: 35 }, bmi: 32 });
    expect(r.recommended_action.urgency).toBe("routine");
    expect(r.recommended_action.action).toMatch(/overweight\/obesity/);
    expect(r.risk.anthropometric_malnutrition_status).toBe("normal");
  });

  it("with nothing usable, says 'not enough measurements' rather than reassuring", () => {
    const r = run({ sex: "male", age: { age_years: 40 } });
    expect(r.nacs_classification).toBeNull();
    expect(r.risk.anthropometric_malnutrition_status).toBe("not_classified_insufficient_data");
    expect(r.recommended_action.action).toMatch(/Not enough measurements/);
  });

  it("oedema explicitly absent with nothing else is 'not classified', not 'normal'", () => {
    const r = run({ sex: "male", age: { age_years: 40 }, edema: false });
    expect(r.risk.anthropometric_malnutrition_status).toBe("not_classified_insufficient_data");
  });

  it("flags missing measurements instead of inventing them", () => {
    const flags = run({ sex: "male", age: { age_years: 40 }, muac_mm: 250 }).clinical_flags.map((f) => f.flag);
    expect(flags).toContain("missing_measurement:edema");
    expect(flags).toContain("missing_measurement:confirmed_weight_loss_over_10_percent");
  });

  it("flags implausible values and an ignored bmi", () => {
    const r = run({ sex: "male", age: { age_years: 40 }, weight_kg: 700, height_cm: 170, bmi: 20 });
    const flags = r.clinical_flags.map((f) => f.flag);
    expect(flags).toContain("data_quality:implausible_value");
    expect(flags).toContain("data_quality:ignored");
  });
});

describe("integratedAdultScreen — older adults and 18-year-olds", () => {
  it("flags 65+ and adds the age-adjustment limitation without changing the classification", () => {
    const older = run({ sex: "female", age: { age_years: 72 }, bmi: 19 });
    const younger = run({ sex: "female", age: { age_years: 40 }, bmi: 19 });
    expect(older.person.older_adult).toBe(true);
    expect(older.limitations.join(" ")).toMatch(/not age-adjusted/);
    expect(older.clinical_flags.map((f) => f.flag)).toContain("older_adult");
    expect(older.risk.anthropometric_malnutrition_status).toBe(younger.risk.anthropometric_malnutrition_status);
    expect(younger.person.older_adult).toBe(false);
  });

  it("adds the cross-check note for 18-year-olds only", () => {
    expect(run({ sex: "male", age: { age_years: 18.5 }, bmi: 20 }).limitations.join(" ")).toMatch(/bmi_for_age_classify/);
    expect(run({ sex: "male", age: { age_years: 25 }, bmi: 20 }).limitations.join(" ")).not.toMatch(/bmi_for_age_classify/);
  });
});

describe("mustScreen — BAPEN MUST scoring", () => {
  const s = (bmi: number, band: "lt_5_percent" | "5_to_10_percent" | "gt_10_percent", acute = false) =>
    mustScreen({ bmi, weight_loss_band: band, acute_disease_no_intake_over_5_days: acute });

  it("BMI bands: > 20 = 0, 20.0 = 1, 18.5 = 1, < 18.5 = 2", () => {
    expect(s(20.1, "lt_5_percent").component_scores.bmi).toBe(0);
    expect(s(20, "lt_5_percent").component_scores.bmi).toBe(1);
    expect(s(18.5, "lt_5_percent").component_scores.bmi).toBe(1);
    expect(s(18.49, "lt_5_percent").component_scores.bmi).toBe(2);
  });

  it("weight-loss bands: < 5% = 0, 5-10% = 1, > 10% = 2", () => {
    expect(s(22, "lt_5_percent").component_scores.weight_loss).toBe(0);
    expect(s(22, "5_to_10_percent").component_scores.weight_loss).toBe(1);
    expect(s(22, "gt_10_percent").component_scores.weight_loss).toBe(2);
  });

  it("acute disease with no intake > 5 days adds 2", () => {
    expect(s(22, "lt_5_percent", true).component_scores.acute_disease).toBe(2);
    expect(s(22, "lt_5_percent", false).component_scores.acute_disease).toBe(0);
  });

  it("total 0 = low, 1 = medium, >= 2 = high", () => {
    expect(s(22, "lt_5_percent").risk_category).toBe("low");
    expect(s(19, "lt_5_percent").risk_category).toBe("medium");
    expect(s(22, "5_to_10_percent").risk_category).toBe("medium");
    expect(s(19, "5_to_10_percent").risk_category).toBe("high");
    expect(s(22, "lt_5_percent", true).risk_category).toBe("high");
    expect(s(17, "gt_10_percent", true).total_score).toBe(6);
  });
});

describe("integratedAdultScreen — MUST as a separate second axis", () => {
  const mustIn = (band: "lt_5_percent" | "5_to_10_percent" | "gt_10_percent", acute = false) => ({
    weight_loss_band: band,
    acute_disease_no_intake_over_5_days: acute,
  });

  it("normal anthropometry but MUST high -> priority dietetic referral, axes kept separate", () => {
    const r = run({ sex: "male", age: { age_years: 60 }, weight_kg: 70, height_cm: 170, muac_mm: 280, edema: false, must: mustIn("lt_5_percent", true) });
    expect(r.risk.anthropometric_malnutrition_status).toBe("normal");
    expect(r.risk.screening_risk_summary).toBe("risk_flagged_by_at_least_one_tool");
    expect(r.screening.must?.risk_category).toBe("high");
    expect(r.recommended_action.urgency).toBe("priority");
    expect(r.recommended_action.action).toMatch(/MUST indicates high/);
  });

  it("MUST low leaves a normal screen routine", () => {
    const r = run({ sex: "male", age: { age_years: 60 }, weight_kg: 70, height_cm: 170, muac_mm: 280, must: mustIn("lt_5_percent") });
    expect(r.risk.screening_risk_summary).toBe("no_risk_flagged");
    expect(r.recommended_action.urgency).toBe("routine");
  });

  it("severe anthropometry still wins over a low MUST", () => {
    const r = run({ sex: "male", age: { age_years: 60 }, muac_mm: 150, bmi: 22, must: mustIn("lt_5_percent") });
    expect(r.recommended_action.urgency).toBe("urgent");
  });

  it("skips MUST, with a reason, when no BMI is available — never invents one", () => {
    const r = run({ sex: "male", age: { age_years: 60 }, muac_mm: 280, must: mustIn("lt_5_percent") });
    expect(r.screening.must).toBeNull();
    expect(r.screening.tools_skipped.some((t) => t.tool === "must" && /BMI/.test(t.reason))).toBe(true);
  });

  it("carries the Malawi protocol TODO", () => {
    expect(run({ sex: "male", age: { age_years: 40 }, muac_mm: 250 }).referral.todo_malawi_protocol).toMatch(/TODO/);
  });
});

describe("integratedAdultScreen — height estimated from ulna length or knee height", () => {
  const base = { sex: "male" as const, age: { age_years: 40 } };

  it("estimates height from ulna length, computes BMI from it, and labels everything as estimated", () => {
    const r = run({ ...base, weight_kg: 60, ulna_length_cm: 26.0 });
    expect(r.measurements.height_source).toBe("ulna_length");
    expect(r.measurements.height_cm).toBe(173);
    expect(r.measurements.bmi).toBe(20.0); // 60 / 1.73^2 = 20.05
    expect(indicator(r, "bmi")?.classification).toBe("normal");
    expect(r.clinical_flags.map((f) => f.flag)).toContain("bmi_from_estimated_height");
    expect(r.limitations.join(" ")).toMatch(/ESTIMATED from ulna length/);
    expect(r.limitations.join(" ")).toMatch(/publishes no error figure/);
    expect(r.explanation).toMatch(/Height estimated from ulna length: 173 cm \(not measured\)/);
    expect(r.clinical_flags.map((f) => f.flag)).not.toContain("missing_measurement:height_cm");
  });

  it("a measured height always wins; the estimation inputs are ignored and flagged", () => {
    const r = run({ ...base, weight_kg: 60, height_cm: 170, ulna_length_cm: 26.0, knee_height_cm: 50, race: "black" });
    expect(r.measurements.height_source).toBe("measured");
    expect(r.measurements.height_cm).toBe(170);
    expect(r.clinical_flags.map((f) => f.flag)).toContain("data_quality:ignored");
    expect(r.clinical_flags.map((f) => f.flag)).not.toContain("bmi_from_estimated_height");
    expect(r.limitations.join(" ")).not.toMatch(/ESTIMATED/);
  });

  it("an out-of-range ulna is flagged, gives no height and no BMI — never a guess", () => {
    const r = run({ ...base, weight_kg: 60, ulna_length_cm: 33 });
    expect(r.measurements.height_source).toBeNull();
    expect(r.measurements.bmi).toBeNull();
    const flags = r.clinical_flags.map((f) => f.flag);
    expect(flags).toContain("data_quality:height_estimate_unavailable");
    expect(flags).toContain("missing_measurement:height_cm");
  });

  it("refuses the doubtful men >=65 / 30.0 cm table cell instead of using a likely typo", () => {
    const r = run({ sex: "male", age: { age_years: 70 }, weight_kg: 60, ulna_length_cm: 30.0 });
    expect(r.measurements.height_source).toBeNull();
    expect(r.measurements.bmi).toBeNull();
    expect(r.clinical_flags.find((f) => f.flag === "data_quality:height_estimate_unavailable")?.detail).toMatch(/NOT estimated/);
  });

  it("knee height needs race; without it the knee height is not used and that is flagged", () => {
    const r = run({ ...base, weight_kg: 60, knee_height_cm: 50 });
    expect(r.measurements.height_source).toBeNull();
    expect(r.clinical_flags.find((f) => f.flag === "data_quality:height_estimate_unavailable")?.detail).toMatch(/race is required/);
  });

  it("knee height with race: estimates height and reports the equation's error and the BMI range it implies", () => {
    const r = run({ ...base, weight_kg: 55, knee_height_cm: 50, race: "black" });
    expect(r.measurements.height_source).toBe("knee_height");
    expect(r.measurements.height_cm).toBe(162.9);
    expect(r.measurements.height_error_cm).toBe(7.2);
    expect(r.measurements.bmi_range_from_estimate_error?.low).toBeLessThan(r.measurements.bmi as number);
    expect(r.measurements.bmi_range_from_estimate_error?.high).toBeGreaterThan(r.measurements.bmi as number);
    expect(r.limitations.join(" ")).toMatch(/\+\/-7\.2 cm/);
  });

  it("flags an uncertain BMI category when the height error straddles a NACS cut-off", () => {
    // 45 kg at 162.9 cm = BMI 17.0; +/-7.2 cm gives about 15.5-18.6, which spans the 16.0 and 18.5 cut-offs
    const r = run({ ...base, weight_kg: 45, knee_height_cm: 50, race: "black" });
    expect(r.clinical_flags.map((f) => f.flag)).toContain("bmi_classification_uncertain");
  });

  it("does not flag uncertainty when the whole error band sits inside one category", () => {
    // 60 kg at 162.9 cm = BMI 22.6; band about 20.7-24.7 — inside 18.5-25
    const r = run({ ...base, weight_kg: 60, knee_height_cm: 50, race: "black" });
    expect(r.clinical_flags.map((f) => f.flag)).not.toContain("bmi_classification_uncertain");
  });

  it("prefers ulna over knee height when both are usable, and falls back to knee height when the ulna is unusable", () => {
    const both = run({ ...base, weight_kg: 60, ulna_length_cm: 26.0, knee_height_cm: 50, race: "black" });
    expect(both.measurements.height_source).toBe("ulna_length");
    const fallback = run({ ...base, weight_kg: 60, ulna_length_cm: 33, knee_height_cm: 50, race: "black" });
    expect(fallback.measurements.height_source).toBe("knee_height");
    expect(fallback.clinical_flags.map((f) => f.flag)).toContain("data_quality:height_estimate_unavailable");
  });

  it("the estimated-height BMI feeds MUST, which is then labelled as resting on an estimate", () => {
    const r = run({
      ...base,
      weight_kg: 45,
      ulna_length_cm: 26.0, // 173 cm -> BMI 15.0
      must: { weight_loss_band: "lt_5_percent", acute_disease_no_intake_over_5_days: false },
    });
    expect(r.screening.must?.component_scores.bmi).toBe(2);
    expect(r.screening.must?.risk_category).toBe("high");
    expect(r.limitations.join(" ")).toMatch(/MUST BMI score/);
  });

  it("without weight, an estimated height alone gives no BMI and MUST stays skipped", () => {
    const r = run({ ...base, ulna_length_cm: 26.0, must: { weight_loss_band: "lt_5_percent", acute_disease_no_intake_over_5_days: false } });
    expect(r.measurements.height_cm).toBe(173);
    expect(r.measurements.bmi).toBeNull();
    expect(r.screening.must).toBeNull();
  });

  it("ulna age band follows the person's age (>=65 uses the older-adult column)", () => {
    const r = run({ sex: "female", age: { age_years: 70 }, weight_kg: 50, ulna_length_cm: 26.0 });
    expect(r.measurements.height_cm).toBe(165);
  });
});

describe("integratedAdultScreen — weight estimated from circumferences / knee height (explicit opt-in)", () => {
  const woman72 = { sex: "female" as const, age: { age_years: 72 }, height_cm: 160 };

  it("65+: estimates weight from arm + calf, computes BMI from it, and labels everything", () => {
    const r = run({ ...woman72, muac_mm: 275, calf_circumference_cm: 31.5, estimate_weight_if_missing: true });
    expect(r.measurements.weight_source).toBe("estimated_65plus");
    expect(r.measurements.weight_kg).toBe(52.4); // (27.5 x 1.63) + (31.5 x 1.43) - 37.46 = 52.41
    expect(r.measurements.weight_error_kg).toBe(4.96);
    expect(r.measurements.bmi).toBe(20.5); // 52.41 / 1.6^2
    expect(r.measurements.bmi_range_from_estimate_error).toEqual({ low: 18.5, high: 22.4 });
    const flags = r.clinical_flags.map((f) => f.flag);
    expect(flags).toContain("bmi_from_estimated_weight");
    expect(flags).not.toContain("missing_measurement:weight_kg + height_cm (or bmi)");
    expect(r.limitations.join(" ")).toMatch(/Weight \(52\.4 kg\) was ESTIMATED/);
    expect(r.limitations.join(" ")).toMatch(/standard error is \+\/-4\.96 kg/);
    expect(r.explanation).toMatch(/Weight estimated: 52\.4 kg/);
  });

  it("flags an uncertain BMI category when the weight error straddles a NACS cut-off", () => {
    // 220 mm arm, 27 cm calf -> about 37.0 kg -> BMI 14.5 (severe), but the +/-4.96 kg band spans about 12.5-16.4, which crosses 16.0
    const r = run({ ...woman72, muac_mm: 220, calf_circumference_cm: 27, estimate_weight_if_missing: true });
    expect(r.measurements.bmi).toBeLessThan(16);
    expect(r.measurements.bmi_range_from_estimate_error?.high).toBeGreaterThan(16);
    expect(r.clinical_flags.map((f) => f.flag)).toContain("bmi_classification_uncertain");
  });

  it("does nothing without the explicit opt-in — weight stays missing and no BMI is invented", () => {
    const r = run({ ...woman72, muac_mm: 275, calf_circumference_cm: 31.5 });
    expect(r.measurements.weight_source).toBeNull();
    expect(r.measurements.weight_kg).toBeNull();
    expect(r.measurements.bmi).toBeNull();
    expect(r.clinical_flags.map((f) => f.flag)).toContain("missing_measurement:weight_kg");
  });

  it("a measured weight always wins; the estimation inputs are ignored and flagged", () => {
    const r = run({ ...woman72, weight_kg: 50, muac_mm: 275, calf_circumference_cm: 31.5, estimate_weight_if_missing: true });
    expect(r.measurements.weight_source).toBe("measured");
    expect(r.measurements.weight_kg).toBe(50);
    expect(r.clinical_flags.map((f) => f.flag)).toContain("data_quality:ignored");
    expect(r.clinical_flags.map((f) => f.flag)).not.toContain("bmi_from_estimated_weight");
    expect(r.limitations.join(" ")).not.toMatch(/Weight .* ESTIMATED/);
  });

  it("under 65 needs knee height + race: 40-year-old man, weight about 65 kg with a +/-11.3 kg error", () => {
    const r = run({
      sex: "male",
      age: { age_years: 40 },
      height_cm: 170,
      muac_mm: 300,
      knee_height_cm: 50,
      race: "black",
      estimate_weight_if_missing: true,
    });
    expect(r.measurements.weight_source).toBe("estimated_knee_height_mac");
    expect(r.measurements.weight_kg).toBe(65); // 64.98
    expect(r.measurements.weight_error_kg).toBe(11.3);
    // BMI 22.5, band about 18.6-26.4 -> crosses 25
    expect(r.clinical_flags.map((f) => f.flag)).toContain("bmi_classification_uncertain");
  });

  it("under 65 with calf but no knee height/race cannot be estimated, and the reason says why", () => {
    const r = run({ sex: "male", age: { age_years: 40 }, height_cm: 170, muac_mm: 300, calf_circumference_cm: 34, estimate_weight_if_missing: true });
    expect(r.measurements.weight_kg).toBeNull();
    const detail = r.clinical_flags.find((f) => f.flag === "data_quality:weight_estimate_unavailable")?.detail;
    expect(detail).toMatch(/65 and older/);
  });

  it("knee height without race is not used for weight", () => {
    const r = run({ sex: "male", age: { age_years: 40 }, height_cm: 170, muac_mm: 300, knee_height_cm: 50, estimate_weight_if_missing: true });
    expect(r.measurements.weight_kg).toBeNull();
    expect(r.clinical_flags.find((f) => f.flag === "data_quality:weight_estimate_unavailable")?.detail).toMatch(/race is required/);
  });

  it("no arm circumference means no estimate", () => {
    const r = run({ ...woman72, calf_circumference_cm: 31.5, estimate_weight_if_missing: true });
    expect(r.measurements.weight_kg).toBeNull();
    expect(r.clinical_flags.find((f) => f.flag === "data_quality:weight_estimate_unavailable")?.detail).toMatch(/muac_mm/);
  });

  it("age 81+ has no race-specific equation, so knee height alone gives no estimate", () => {
    const r = run({ sex: "female", age: { age_years: 85 }, height_cm: 155, muac_mm: 250, knee_height_cm: 45, race: "black", estimate_weight_if_missing: true });
    expect(r.measurements.weight_kg).toBeNull();
    expect(r.clinical_flags.find((f) => f.flag === "data_quality:weight_estimate_unavailable")?.detail).toMatch(/No matching equation/);
  });

  it("when both equation sets apply (65-80), the lowest standard error is used and the other is listed", () => {
    const r = run({
      sex: "male",
      age: { age_years: 70 },
      height_cm: 170,
      muac_mm: 265,
      calf_circumference_cm: 31,
      knee_height_cm: 50,
      race: "black",
      estimate_weight_if_missing: true,
    });
    expect(r.measurements.weight_source).toBe("estimated_65plus");
    expect(r.measurements.weight_error_kg).toBe(5.37);
    expect(r.measurements.weight_estimate?.alternatives.map((a) => a.see_kg)).toEqual([7.04]);
  });

  it("an implausible estimate (tiny measurements) is refused rather than used", () => {
    const r = run({ sex: "female", age: { age_years: 70 }, height_cm: 160, muac_mm: 100, calf_circumference_cm: 15, estimate_weight_if_missing: true });
    expect(r.measurements.weight_kg).toBeNull();
    expect(r.clinical_flags.find((f) => f.flag === "data_quality:weight_estimate_unavailable")?.detail).toMatch(/plausible range/);
  });

  it("the estimated-weight BMI feeds MUST and MUST's result is labelled as resting on an estimate", () => {
    const r = run({
      ...woman72,
      muac_mm: 220,
      calf_circumference_cm: 27,
      estimate_weight_if_missing: true,
      must: { weight_loss_band: "lt_5_percent", acute_disease_no_intake_over_5_days: false },
    });
    expect(r.screening.must?.component_scores.bmi).toBe(2);
    expect(r.limitations.join(" ")).toMatch(/MUST BMI score/);
  });

  it("MUAC/oedema-based findings never depend on the estimate: severe MUAC is severe whatever the estimated BMI says", () => {
    const r = run({ ...woman72, muac_mm: 170, calf_circumference_cm: 31.5, estimate_weight_if_missing: true });
    expect(indicator(r, "muac")?.classification).toBe("severe");
    expect(r.recommended_action.urgency).toBe("urgent");
  });

  it("both estimated (ulna height + calf weight): range comes from the weight error only, since the ulna table publishes none", () => {
    const r = run({
      sex: "female",
      age: { age_years: 72 },
      ulna_length_cm: 26.0,
      muac_mm: 275,
      calf_circumference_cm: 31.5,
      estimate_weight_if_missing: true,
    });
    expect(r.measurements.height_source).toBe("ulna_length");
    expect(r.measurements.weight_source).toBe("estimated_65plus");
    expect(r.measurements.bmi_range_from_estimate_error).toBeDefined();
    const flags = r.clinical_flags.map((f) => f.flag);
    expect(flags).toContain("bmi_from_estimated_height");
    expect(flags).toContain("bmi_from_estimated_weight");
  });
});
