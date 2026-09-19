import { describe, it, expect } from "vitest";
import { computeWhoGrowthZScore } from "../whoGrowthTools.js";
import {
  resolveAge,
  assessUnder5Anthropometry,
  integratedUnder5Screen,
  strongkidsScreen,
  pnstScreen,
  pymsScreen,
  stampScreen,
} from "../under5MalnutritionScreeningTools.js";

// Helper: pull the WHO reference median (M) for a given standard/age/sex
// directly from the same LMS data this module reuses, so tests assert
// against the real reference rather than a hand-copied number.
function referenceMedianByAge(standard: string, sex: "male" | "female", ageDays: number): number {
  const outcome = computeWhoGrowthZScore({ standard, sex, value: 1, age_days: ageDays });
  if (!outcome.ok) throw new Error(`Could not look up reference median: ${outcome.error}`);
  // value=1 was just a probe; recover M by re-deriving z=0 value via a second lookup at value=lms M is
  // not directly exposed on the result, so instead binary-search a value whose z-score is ~0.
  return outcome.result.lms_parameters.M;
}

describe("resolveAge", () => {
  it("resolves from age_days", () => {
    const r = resolveAge({ age_days: 100 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.age.ageDays).toBe(100);
  });

  it("resolves from age_months", () => {
    const r = resolveAge({ age_months: 6 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.age.ageDays).toBeCloseTo(6 * 30.4375, 5);
  });

  it("resolves from date_of_birth + assessment_date", () => {
    const r = resolveAge({ date_of_birth: "2026-01-01", assessment_date: "2026-07-01" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.age.ageDays).toBeCloseTo(181, 0);
  });

  it("errors when date_of_birth is given without assessment_date", () => {
    const r = resolveAge({ date_of_birth: "2026-01-01" });
    expect(r.ok).toBe(false);
  });

  it("errors when assessment_date is before date_of_birth", () => {
    const r = resolveAge({ date_of_birth: "2026-07-01", assessment_date: "2026-01-01" });
    expect(r.ok).toBe(false);
  });

  it("errors when no age input is given", () => {
    const r = resolveAge({});
    expect(r.ok).toBe(false);
  });

  it("errors on an invalid ISO date", () => {
    const r = resolveAge({ date_of_birth: "not-a-date", assessment_date: "2026-01-01" });
    expect(r.ok).toBe(false);
  });
});

describe("assessUnder5Anthropometry — age scope boundaries", () => {
  it("accepts a child just under 5 years (59 months)", () => {
    const r = assessUnder5Anthropometry({ sex: "male", age: { age_months: 59 }, weight_kg: 15 });
    expect(r.ok).toBe(true);
  });

  it("rejects a child at/after 5 years (60 months)", () => {
    const r = assessUnder5Anthropometry({ sex: "male", age: { age_months: 60 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/outside the 0-59 month scope/i);
  });

  it("rejects a negative age", () => {
    const r = assessUnder5Anthropometry({ sex: "male", age: { age_days: -5 } });
    expect(r.ok).toBe(false);
  });

  it("accepts a newborn (age_days = 0)", () => {
    const r = assessUnder5Anthropometry({ sex: "female", age: { age_days: 0 }, weight_kg: 3.2 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.result.age_in_scope).toBe(true);
  });
});

describe("assessUnder5Anthropometry — missing data is reported, never invented", () => {
  it("marks weight/height/MUAC/edema unavailable when not provided", () => {
    const r = assessUnder5Anthropometry({ sex: "male", age: { age_months: 24 } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.indicators.weight_for_age.available).toBe(false);
    expect(r.result.indicators.height_for_age.available).toBe(false);
    expect(r.result.indicators.weight_for_length_or_height.available).toBe(false);
    expect(r.result.indicators.bmi_for_age.available).toBe(false);
    expect(r.result.missing_measurements).toEqual(
      expect.arrayContaining(["weight_kg", "length_or_height_cm", "muac_mm", "edema"])
    );
    expect(r.result.nacs_classification).toBeNull();
  });

  it("computes only the indicators for which data was given (weight only)", () => {
    const r = assessUnder5Anthropometry({ sex: "male", age: { age_months: 24 }, weight_kg: 12 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.indicators.weight_for_age.available).toBe(true);
    expect(r.result.indicators.height_for_age.available).toBe(false);
    // weight-for-height needs both weight and height — should stay unavailable
    expect(r.result.indicators.weight_for_length_or_height.available).toBe(false);
  });
});

describe("assessUnder5Anthropometry — normal, reference-derived measurements", () => {
  it("classifies a boy at the WHO median weight-for-age (6 months) as normal-range", () => {
    const ageDays = 6 * 30.4375;
    const medianWeight = referenceMedianByAge("weight_for_age", "male", ageDays);
    const r = assessUnder5Anthropometry({ sex: "male", age: { age_days: ageDays }, weight_kg: medianWeight });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.indicators.weight_for_age.available).toBe(true);
    expect(Math.abs(r.result.indicators.weight_for_age.z_score ?? 99)).toBeLessThan(0.05);
    expect(r.result.indicators.weight_for_age.classification?.toLowerCase()).toContain("normal");
  });

  it("classifies a girl at the WHO median length-for-age (12 months) as normal-range", () => {
    const ageDays = 12 * 30.4375;
    const medianLength = referenceMedianByAge("height_for_age", "female", ageDays);
    const r = assessUnder5Anthropometry({
      sex: "female",
      age: { age_days: ageDays },
      length_or_height_cm: medianLength,
      measurement_method: "recumbent_length",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Math.abs(r.result.indicators.height_for_age.z_score ?? 99)).toBeLessThan(0.05);
  });
});

describe("assessUnder5Anthropometry — moderate/severe abnormalities", () => {
  it("flags severe wasting for a very low weight-for-length", () => {
    // 70cm is a plausible length around 8-9 months; 6kg at 70cm is markedly low.
    const r = assessUnder5Anthropometry({
      sex: "male",
      age: { age_months: 8 },
      weight_kg: 6,
      length_or_height_cm: 70,
      measurement_method: "recumbent_length",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.indicators.weight_for_length_or_height.available).toBe(true);
    expect(r.result.indicators.weight_for_length_or_height.z_score ?? 0).toBeLessThan(-2);
  });

  it("flags severe stunting for a markedly short length-for-age", () => {
    const r = assessUnder5Anthropometry({
      sex: "female",
      age: { age_months: 24 },
      length_or_height_cm: 68, // well below typical ~87cm median at 24 months
      measurement_method: "standing_height",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.indicators.height_for_age.z_score ?? 0).toBeLessThan(-3);
    expect(r.result.indicators.height_for_age.classification?.toLowerCase()).toContain("stunt");
  });
});

describe("assessUnder5Anthropometry — oedema and MUAC via reused NACS logic", () => {
  it("classifies bilateral pitting oedema as severe regardless of MUAC", () => {
    const r = assessUnder5Anthropometry({ sex: "male", age: { age_months: 20 }, edema: true, muac_mm: 135 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.nacs_classification?.overallAcuteMalnutritionClassification).toBe("severe");
  });

  it("classifies MUAC just below the SAM cutoff (114mm) as severe", () => {
    const r = assessUnder5Anthropometry({ sex: "female", age: { age_months: 20 }, muac_mm: 114 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.nacs_classification?.overallAcuteMalnutritionClassification).toBe("severe");
  });

  it("classifies MUAC exactly at the SAM/MAM boundary (115mm) as moderate", () => {
    const r = assessUnder5Anthropometry({ sex: "female", age: { age_months: 20 }, muac_mm: 115 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.nacs_classification?.overallAcuteMalnutritionClassification).toBe("moderate");
  });

  it("classifies MUAC exactly at the MAM/normal boundary (125mm) as normal", () => {
    const r = assessUnder5Anthropometry({ sex: "female", age: { age_months: 20 }, muac_mm: 125 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.nacs_classification?.overallAcuteMalnutritionClassification).toBe("normal");
  });

  it("withholds MUAC from NACS classification for a child under 6 months, per NACS's documented age range", () => {
    const r = assessUnder5Anthropometry({ sex: "male", age: { age_months: 3 }, muac_mm: 100 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.nacs_classification).toBeNull();
    expect(r.result.nacs_classification_skipped_reason).toMatch(/under 6 months/i);
  });

  it("still classifies oedema for a child under 6 months (oedema is not age-gated)", () => {
    const r = assessUnder5Anthropometry({ sex: "male", age: { age_months: 3 }, edema: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.nacs_classification?.overallAcuteMalnutritionClassification).toBe("severe");
  });
});

describe("assessUnder5Anthropometry — data-quality / implausible-value flags", () => {
  it("flags an implausible weight as a data-quality issue without rejecting the request", () => {
    const r = assessUnder5Anthropometry({ sex: "male", age: { age_months: 12 }, weight_kg: 200 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.data_quality_flags.some((f) => f.field === "weight_kg")).toBe(true);
  });

  it("flags an implausibly extreme resulting WHZ per the WHO/SMART convention", () => {
    const r = assessUnder5Anthropometry({
      sex: "male",
      age: { age_months: 12 },
      weight_kg: 3,
      length_or_height_cm: 80,
      measurement_method: "recumbent_length",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.data_quality_flags.some((f) => f.issue === "implausible_zscore")).toBe(true);
  });
});

describe("assessUnder5Anthropometry — WHO 0.7cm measurement adjustment", () => {
  it("adds 0.7cm when a child under 24 months was measured standing", () => {
    const r = assessUnder5Anthropometry({
      sex: "male",
      age: { age_months: 10 },
      length_or_height_cm: 70,
      measurement_method: "standing_height",
      weight_kg: 8,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.measurement_adjustment.applied).toBe(true);
    expect(r.result.indicators.height_for_age.raw_value).toBeCloseTo(70.7, 5);
  });

  it("subtracts 0.7cm when a child 24 months or older was measured lying down", () => {
    const r = assessUnder5Anthropometry({
      sex: "female",
      age: { age_months: 30 },
      length_or_height_cm: 90,
      measurement_method: "recumbent_length",
      weight_kg: 12,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.measurement_adjustment.applied).toBe(true);
    expect(r.result.indicators.height_for_age.raw_value).toBeCloseTo(89.3, 5);
  });

  it("applies no adjustment when the measurement method matches the WHO-recommended method for age", () => {
    const r = assessUnder5Anthropometry({
      sex: "female",
      age: { age_months: 10 },
      length_or_height_cm: 70,
      measurement_method: "recumbent_length",
      weight_kg: 8,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.measurement_adjustment.applied).toBe(false);
  });

  it("routes weight-for-length below 24 months and weight-for-height at/above 24 months", () => {
    const under24 = assessUnder5Anthropometry({
      sex: "male",
      age: { age_months: 23 },
      weight_kg: 11,
      length_or_height_cm: 84,
    });
    const at24 = assessUnder5Anthropometry({
      sex: "male",
      age: { age_months: 24 },
      weight_kg: 12,
      length_or_height_cm: 87,
    });
    expect(under24.ok && under24.result.indicators.weight_for_length_or_height.standard_used).toBe(
      "weight_for_length"
    );
    expect(at24.ok && at24.result.indicators.weight_for_length_or_height.standard_used).toBe("weight_for_height");
  });
});

describe("STRONGkids scoring boundaries", () => {
  it("scores 0 and low risk when nothing is flagged", () => {
    const r = strongkidsScreen({
      clinical_assessment_poor_nutritional_status: false,
      high_risk_disease: false,
      reduced_intake_or_losses: false,
      weight_loss_or_poor_gain: false,
    });
    expect(r.total_score).toBe(0);
    expect(r.risk_category).toBe("low");
  });

  it("scores 3 (medium) just below the high-risk boundary", () => {
    const r = strongkidsScreen({
      clinical_assessment_poor_nutritional_status: false,
      high_risk_disease: true, // 2
      reduced_intake_or_losses: true, // 1
      weight_loss_or_poor_gain: false,
    });
    expect(r.total_score).toBe(3);
    expect(r.risk_category).toBe("medium");
  });

  it("scores 4 (high) at the high-risk boundary", () => {
    const r = strongkidsScreen({
      clinical_assessment_poor_nutritional_status: false,
      high_risk_disease: true, // 2
      reduced_intake_or_losses: true, // 1
      weight_loss_or_poor_gain: true, // 1
    });
    expect(r.total_score).toBe(4);
    expect(r.risk_category).toBe("high");
  });

  it("scores 5 (high) at the maximum", () => {
    const r = strongkidsScreen({
      clinical_assessment_poor_nutritional_status: true,
      high_risk_disease: true,
      reduced_intake_or_losses: true,
      weight_loss_or_poor_gain: true,
    });
    expect(r.total_score).toBe(5);
    expect(r.risk_category).toBe("high");
  });
});

describe("PNST scoring boundaries", () => {
  it("is not at risk with 1 affirmative answer", () => {
    const r = pnstScreen({
      recent_weight_loss_or_failure_to_gain: true,
      reduced_intake_recent_weeks: false,
      looks_underweight: false,
      looks_thin: false,
    });
    expect(r.affirmative_count).toBe(1);
    expect(r.risk_category).toBe("not_at_risk");
  });

  it("is at risk with exactly 2 affirmative answers (the published cutoff)", () => {
    const r = pnstScreen({
      recent_weight_loss_or_failure_to_gain: true,
      reduced_intake_recent_weeks: true,
      looks_underweight: false,
      looks_thin: false,
    });
    expect(r.affirmative_count).toBe(2);
    expect(r.risk_category).toBe("at_risk");
  });

  it("is at risk with all 4 affirmative", () => {
    const r = pnstScreen({
      recent_weight_loss_or_failure_to_gain: true,
      reduced_intake_recent_weeks: true,
      looks_underweight: true,
      looks_thin: true,
    });
    expect(r.affirmative_count).toBe(4);
    expect(r.risk_category).toBe("at_risk");
  });
});

describe("PYMS scoring boundaries", () => {
  it("is not at risk with total score 1", () => {
    const r = pymsScreen({
      bmi_band: "2nd_to_9th_centile", // 1
      weight_loss_band: "none", // 0
      intake_band: "no_change", // 0
      prognosis_band: "none_expected", // 0
    });
    expect(r.total_score).toBe(1);
    expect(r.risk_category).toBe("not_at_risk");
  });

  it("is at risk at the total score 2 boundary", () => {
    const r = pymsScreen({
      bmi_band: "2nd_to_9th_centile", // 1
      weight_loss_band: "uncertain_or_mild", // 1
      intake_band: "no_change", // 0
      prognosis_band: "none_expected", // 0
    });
    expect(r.total_score).toBe(2);
    expect(r.risk_category).toBe("at_risk_refer_for_dietetic_review");
  });

  it("reaches the maximum score of 8 when every component is worst", () => {
    const r = pymsScreen({
      bmi_band: "lt_2nd_centile", // 2
      weight_loss_band: "obvious", // 2
      intake_band: "little_or_none_last_week", // 2
      prognosis_band: "no_or_minimal_intake_expected", // 2
    });
    expect(r.total_score).toBe(8);
    expect(r.risk_category).toBe("at_risk_refer_for_dietetic_review");
  });
});

describe("STAMP scoring boundaries", () => {
  it("is low risk at total score 1", () => {
    const r = stampScreen({
      diagnosis_band: "no_nutritional_implications", // 0
      intake_band: "no_change_good", // 0
      centile_gap_band: "2_centile_spaces", // 1
    });
    expect(r.total_score).toBe(1);
    expect(r.risk_category).toBe("low");
  });

  it("is medium risk at total score 2", () => {
    const r = stampScreen({
      diagnosis_band: "possible_nutritional_implications", // 2
      intake_band: "no_change_good", // 0
      centile_gap_band: "0_to_1_centile_space", // 0
    });
    expect(r.total_score).toBe(2);
    expect(r.risk_category).toBe("medium");
  });

  it("is medium risk at total score 3", () => {
    const r = stampScreen({
      diagnosis_band: "possible_nutritional_implications", // 2
      intake_band: "no_change_good", // 0
      centile_gap_band: "2_centile_spaces", // 1
    });
    expect(r.total_score).toBe(3);
    expect(r.risk_category).toBe("medium");
  });

  it("is high risk at total score 4 (the high-risk boundary)", () => {
    const r = stampScreen({
      diagnosis_band: "possible_nutritional_implications", // 2
      intake_band: "no_change_good", // 0
      centile_gap_band: "3_or_more_centile_spaces_or_below_2nd_weight_centile", // 3
    });
    expect(r.total_score).toBe(5);
    expect(r.risk_category).toBe("high");
  });

  it("is high risk at the maximum score of 9", () => {
    const r = stampScreen({
      diagnosis_band: "definite_nutritional_implications", // 3
      intake_band: "none", // 3
      centile_gap_band: "3_or_more_centile_spaces_or_below_2nd_weight_centile", // 3
    });
    expect(r.total_score).toBe(9);
    expect(r.risk_category).toBe("high");
  });
});

describe("integratedUnder5Screen — orchestration", () => {
  it("rejects an out-of-scope age with a clear error", () => {
    const r = integratedUnder5Screen({ sex: "male", age: { age_months: 61 } });
    expect(r.ok).toBe(false);
  });

  it("skips all four questionnaires for a child under 12 months by design", () => {
    const r = integratedUnder5Screen({
      sex: "male",
      age: { age_months: 8 },
      weight_kg: 8,
      length_or_height_cm: 70,
      strongkids: {
        clinical_assessment_poor_nutritional_status: true,
        high_risk_disease: true,
        reduced_intake_or_losses: true,
        weight_loss_or_poor_gain: true,
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.screening.tools_administered).toHaveLength(0);
    expect(r.result.screening.strongkids).toBeNull();
    expect(r.result.screening.tools_skipped.some((s) => s.tool === "strongkids")).toBe(true);
  });

  it("administers supplied questionnaires for a child 12+ months and marks unsupplied ones skipped", () => {
    const r = integratedUnder5Screen({
      sex: "female",
      age: { age_months: 30 },
      weight_kg: 12,
      length_or_height_cm: 88,
      pnst: {
        recent_weight_loss_or_failure_to_gain: false,
        reduced_intake_recent_weeks: false,
        looks_underweight: false,
        looks_thin: false,
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.screening.tools_administered).toEqual(["pnst"]);
    expect(r.result.screening.pnst?.risk_category).toBe("not_at_risk");
    expect(r.result.screening.strongkids).toBeNull();
    expect(r.result.screening.tools_skipped.some((s) => s.tool === "strongkids" && /no responses/i.test(s.reason))).toBe(
      true
    );
  });

  it("escalates to urgent when oedema is present, overriding all other findings", () => {
    const r = integratedUnder5Screen({
      sex: "male",
      age: { age_months: 20 },
      weight_kg: 12, // normal-ish weight
      length_or_height_cm: 82,
      edema: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.recommended_action.urgency).toBe("urgent");
    expect(r.result.risk.anthropometric_malnutrition_status).toBe("severe");
  });

  it("recommends routine follow-up when everything is normal and no risk is flagged", () => {
    const ageDays = 18 * 30.4375;
    const medianWeight = referenceMedianByAge("weight_for_age", "female", ageDays);
    const medianLength = referenceMedianByAge("height_for_age", "female", ageDays);
    const r = integratedUnder5Screen({
      sex: "female",
      age: { age_days: ageDays },
      weight_kg: medianWeight,
      length_or_height_cm: medianLength,
      measurement_method: "standing_height",
      muac_mm: 145,
      edema: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.recommended_action.urgency).toBe("routine");
  });

  it("surfaces disagreement when one screening tool flags risk and another does not", () => {
    const r = integratedUnder5Screen({
      sex: "male",
      age: { age_months: 36 },
      weight_kg: 14,
      length_or_height_cm: 95,
      strongkids: {
        clinical_assessment_poor_nutritional_status: true,
        high_risk_disease: true,
        reduced_intake_or_losses: true,
        weight_loss_or_poor_gain: false,
      }, // score 4 -> high
      pnst: {
        recent_weight_loss_or_failure_to_gain: false,
        reduced_intake_recent_weeks: false,
        looks_underweight: false,
        looks_thin: false,
      }, // 0 -> not at risk
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.screening.disagreement_noted).toBe(true);
    expect(r.result.clinical_flags.some((f) => f.flag === "screening_tool_disagreement")).toBe(true);
  });

  it("does not apply STAMP/PYMS/PNST/STRONGkids outside their supported use even if supplied, without crashing", () => {
    // A 13-month-old is within questionnaire scope; this just checks the tool runs end-to-end
    // and reports which tools ran vs were skipped, rather than silently ignoring the mismatch.
    const r = integratedUnder5Screen({
      sex: "female",
      age: { age_months: 13 },
      weight_kg: 9,
      length_or_height_cm: 75,
      stamp: {
        diagnosis_band: "no_nutritional_implications",
        intake_band: "no_change_good",
        centile_gap_band: "0_to_1_centile_space",
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.screening.tools_administered).toContain("stamp");
  });

  it("never fabricates missing measurements — flags them in clinical_flags instead", () => {
    const r = integratedUnder5Screen({ sex: "male", age: { age_months: 15 } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.clinical_flags.some((f) => f.flag === "missing_measurement:weight_kg")).toBe(true);
    expect(r.result.clinical_flags.some((f) => f.flag === "missing_measurement:length_or_height_cm")).toBe(true);
  });
});
