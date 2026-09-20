import { describe, it, expect } from "vitest";
import { integratedSchoolAgeScreen, assessBmiForAge } from "../schoolAgeScreeningTools.js";
import type { BmiForAgeFetcher, BmiForAgeStatus } from "../bmiForAgeTools.js";

/**
 * Tests inject a fake BmiForAgeFetcher, so nothing here touches the network.
 * The Annex 2 worked example (girl, 7y 11m = 95 months, 26.0 kg, 121.1 cm -> BMI 17.73, overweight)
 * is the same one used by chakudya-api's own test/bmiForAge.test.js.
 */
const api = (status: BmiForAgeStatus): BmiForAgeFetcher => async (q) => ({
  sex: q.sex === "female" ? "girls" : "boys",
  age_months: q.age_months,
  status,
  bmi: 0,
  cutoffs: {},
  source: "test-fixture",
});
const apiDown: BmiForAgeFetcher = async () => {
  throw new Error("Chakudya API error (503): down");
};

describe("integratedSchoolAgeScreen — scope and validation", () => {
  it("declines a pregnant/postpartum adolescent and points to the maternal tool", async () => {
    const r = await integratedSchoolAgeScreen({ sex: "female", age: { age_years: 16 }, muac_mm: 250, pregnant_or_postpartum: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/pregnant_postpartum_integrated_screen/);
  });

  it("rejects under-5s (below 60 months) and points to the under-5 tool", async () => {
    const r = await integratedSchoolAgeScreen({ sex: "male", age: { age_months: 59 }, muac_mm: 130 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/under5_integrated_screen/);
  });

  it("rejects 18+ and points to the adult tool", async () => {
    const r = await integratedSchoolAgeScreen({ sex: "male", age: { age_years: 18 }, muac_mm: 250 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/adult_integrated_screen/);
  });

  it("accepts 17y 11m (just under the adult boundary)", async () => {
    const r = await integratedSchoolAgeScreen({ sex: "male", age: { age_months: 215 }, muac_mm: 250 }, { fetchBmiForAge: api("normal") });
    expect(r.ok).toBe(true);
  });

  it("requires an age", async () => {
    const r = await integratedSchoolAgeScreen({ sex: "male", age: {}, muac_mm: 200 });
    expect(r.ok).toBe(false);
  });
});

describe("integratedSchoolAgeScreen — BMI-for-age via the Chakudya API", () => {
  it("Annex 2 worked example: uses the API status, is overweight, routine counselling, and API + local agree", async () => {
    const r = await integratedSchoolAgeScreen(
      { sex: "female", age: { age_months: 95 }, weight_kg: 26, height_cm: 121.1 },
      { fetchBmiForAge: api("overweight") }
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const b = r.result.anthropometry.bmi_for_age;
    expect(b.available).toBe(true);
    expect(b.status).toBe("overweight");
    expect(b.source).toBe("chakudya_api_bmi_for_age");
    expect(b.sources_agree).toBe(true);
    expect(b.bmi).toBe(17.7);
    expect(r.result.recommended_action.urgency).toBe("routine");
    expect(r.result.recommended_action.action).toMatch(/overweight/i);
    // overweight never masquerades as acute malnutrition
    expect(r.result.risk.anthropometric_malnutrition_status).toBe("normal");
  });

  it("sends completed months and weight+height (not a rounded BMI) to the API", async () => {
    let seen: Parameters<BmiForAgeFetcher>[0] | undefined;
    const spy: BmiForAgeFetcher = async (q) => {
      seen = q;
      return { sex: "girls", age_months: q.age_months, status: "overweight", bmi: 17.7, cutoffs: {}, source: "t" };
    };
    await integratedSchoolAgeScreen({ sex: "female", age: { age_months: 95.9 }, weight_kg: 26, height_cm: 121.1 }, { fetchBmiForAge: spy });
    expect(seen?.age_months).toBe(95);
    expect(seen?.weight_kg).toBe(26);
    expect(seen?.height_cm).toBe(121.1);
    expect(seen?.sex).toBe("female");
  });

  it("classifies severe thinness as severe -> urgent", async () => {
    const r = await integratedSchoolAgeScreen({ sex: "male", age: { age_years: 9 }, weight_kg: 15, height_cm: 125 }, { fetchBmiForAge: api("severe thinness") });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.risk.anthropometric_malnutrition_status).toBe("severe");
    expect(r.result.recommended_action.urgency).toBe("urgent");
  });

  it("classifies thinness as moderate -> priority", async () => {
    const r = await integratedSchoolAgeScreen({ sex: "male", age: { age_years: 9 }, weight_kg: 18, height_cm: 130 }, { fetchBmiForAge: api("thinness") });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.risk.anthropometric_malnutrition_status).toBe("moderate");
    expect(r.result.recommended_action.urgency).toBe("priority");
  });

  it("obesity is reported as an indicator and gets counselling, not an urgent referral", async () => {
    const r = await integratedSchoolAgeScreen({ sex: "female", age: { age_years: 12 }, bmi: 30 }, { fetchBmiForAge: api("obesity") });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.nacs_classification?.indicators.some((i) => i.classification === "obesity")).toBe(true);
    expect(r.result.recommended_action.urgency).toBe("routine");
  });

  it("falls back to the in-process WHO 2007 calculation when the API is down, and says so", async () => {
    const r = await integratedSchoolAgeScreen({ sex: "female", age: { age_months: 95 }, weight_kg: 26, height_cm: 121.1 }, { fetchBmiForAge: apiDown });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const b = r.result.anthropometry.bmi_for_age;
    expect(b.available).toBe(true);
    expect(b.source).toBe("local_who2007_lms");
    expect(b.status).toBe("overweight"); // same answer as the API table for the guide example
    expect(b.sources_agree).toBeNull();
    expect(b.api_error).toMatch(/503/);
    expect(r.result.limitations.join(" ")).toMatch(/in-process WHO 2007/);
  });

  it("uses the API status and flags a disagreement when the two sources differ", async () => {
    // Local WHO 2007 puts this BMI well inside 'overweight'; the fixture API claims 'normal'.
    const r = await integratedSchoolAgeScreen({ sex: "female", age: { age_months: 95 }, bmi: 19.5 }, { fetchBmiForAge: api("normal") });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const b = r.result.anthropometry.bmi_for_age;
    expect(b.status).toBe("normal"); // API wins
    expect(b.sources_agree).toBe(false);
    expect(r.result.clinical_flags.map((f) => f.flag)).toContain("bmi_for_age_source_disagreement");
  });

  it("ignores a supplied bmi when weight and height are both given, and flags it", async () => {
    const r = await integratedSchoolAgeScreen({ sex: "female", age: { age_months: 95 }, weight_kg: 26, height_cm: 121.1, bmi: 12 }, { fetchBmiForAge: api("overweight") });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.anthropometry.bmi_for_age.bmi).toBe(17.7);
    expect(r.result.clinical_flags.map((f) => f.flag)).toContain("data_quality:ignored");
  });

  it("reports BMI-for-age unavailable between 60 and 61 months but still classifies MUAC/oedema", async () => {
    const r = await integratedSchoolAgeScreen({ sex: "male", age: { age_months: 60 }, weight_kg: 16, height_cm: 105, muac_mm: 130 }, { fetchBmiForAge: api("normal") });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.anthropometry.bmi_for_age.available).toBe(false);
    expect(r.result.nacs_classification?.indicators.some((i) => i.indicator === "muac" && i.classification === "severe")).toBe(true);
    expect(r.result.recommended_action.urgency).toBe("urgent");
    expect(r.result.limitations.join(" ")).toMatch(/5y 1m/);
  });
});

describe("assessBmiForAge", () => {
  it("is unavailable outside 61-228 completed months and never calls the API", async () => {
    let called = false;
    const spy: BmiForAgeFetcher = async () => {
      called = true;
      throw new Error("should not be called");
    };
    const r = await assessBmiForAge({ sex: "male", ageMonths: 229, ageDays: 229 * 30.4375, bmi: 20 }, spy);
    expect(r.available).toBe(false);
    expect(called).toBe(false);
  });

  it("is unavailable for a non-positive or non-finite BMI and never calls the API", async () => {
    let called = false;
    const spy: BmiForAgeFetcher = async () => {
      called = true;
      throw new Error("should not be called");
    };
    expect((await assessBmiForAge({ sex: "male", ageMonths: 100, ageDays: 100 * 30.4375, bmi: Number.NaN }, spy)).available).toBe(false);
    expect((await assessBmiForAge({ sex: "male", ageMonths: 100, ageDays: 100 * 30.4375, bmi: 0 }, spy)).available).toBe(false);
    expect(called).toBe(false);
  });

  it("keeps the API error visible when it falls back to the local calculation", async () => {
    const r = await assessBmiForAge({ sex: "male", ageMonths: 100, ageDays: 100 * 30.4375, bmi: 15 }, apiDown);
    expect(r.available).toBe(true);
    expect(r.source).toBe("local_who2007_lms");
    expect(r.api_error).toMatch(/503/);
  });
});

describe("integratedSchoolAgeScreen — NACS MUAC bands and oedema (reused engine)", () => {
  const normalApi = { fetchBmiForAge: api("normal") };

  it("uses the 5-9y band: 134mm severe, 135mm moderate, 144mm moderate, 145mm normal", async () => {
    const cls = async (muac: number) => {
      const r = await integratedSchoolAgeScreen({ sex: "male", age: { age_years: 8 }, muac_mm: muac }, normalApi);
      if (!r.ok) throw new Error(r.error);
      return r.result.nacs_classification?.indicators.find((i) => i.indicator === "muac")?.classification;
    };
    expect(await cls(134)).toBe("severe");
    expect(await cls(135)).toBe("moderate");
    expect(await cls(144)).toBe("moderate");
    expect(await cls(145)).toBe("normal");
  });

  it("switches band at exactly 10 years (160/185) and at exactly 15 years (185/220)", async () => {
    const cls = async (years: number, muac: number) => {
      const r = await integratedSchoolAgeScreen({ sex: "female", age: { age_years: years }, muac_mm: muac }, normalApi);
      if (!r.ok) throw new Error(r.error);
      return r.result.nacs_classification?.indicators.find((i) => i.indicator === "muac")?.classification;
    };
    expect(await cls(10, 150)).toBe("severe"); // < 160 in the 10-14 band (would be normal in the 5-9 band)
    expect(await cls(14.9, 190)).toBe("normal");
    expect(await cls(15, 190)).toBe("moderate"); // 185-219 in the 15-17 band
    expect(await cls(15, 184)).toBe("severe");
  });

  it("treats oedema as severe -> urgent regardless of BMI-for-age or MUAC", async () => {
    const r = await integratedSchoolAgeScreen({ sex: "male", age: { age_years: 7 }, edema: true, muac_mm: 200, bmi: 16 }, normalApi);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.risk.anthropometric_malnutrition_status).toBe("severe");
    expect(r.result.recommended_action.urgency).toBe("urgent");
  });

  it("worst indicator wins: normal BMI-for-age + severe MUAC is severe", async () => {
    const r = await integratedSchoolAgeScreen({ sex: "male", age: { age_years: 12 }, muac_mm: 150, bmi: 17 }, normalApi);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.risk.anthropometric_malnutrition_status).toBe("severe");
  });
});

describe("integratedSchoolAgeScreen — missing data, quality flags, questionnaire", () => {
  it("never fabricates: flags missing measurements and says 'not enough to classify' when nothing usable was given", async () => {
    const r = await integratedSchoolAgeScreen({ sex: "female", age: { age_years: 10 } }, { fetchBmiForAge: api("normal") });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.nacs_classification).toBeNull();
    expect(r.result.risk.anthropometric_malnutrition_status).toBe("not_classified_insufficient_data");
    expect(r.result.recommended_action.action).toMatch(/Not enough measurements/);
    const flags = r.result.clinical_flags.map((f) => f.flag);
    expect(flags).toContain("missing_measurement:muac_mm");
    expect(flags).toContain("missing_measurement:edema");
  });

  it("oedema explicitly absent with nothing else is still 'not classified'", async () => {
    const r = await integratedSchoolAgeScreen({ sex: "female", age: { age_years: 10 }, edema: false }, { fetchBmiForAge: api("normal") });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.risk.anthropometric_malnutrition_status).toBe("not_classified_insufficient_data");
  });

  it("flags an implausible weight (kg/lb or typo) instead of silently using it", async () => {
    const r = await integratedSchoolAgeScreen({ sex: "male", age: { age_years: 9 }, weight_kg: 250, height_cm: 130 }, { fetchBmiForAge: api("obesity") });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.measurement_quality.data_quality_flags.some((f) => f.field === "weight_kg")).toBe(true);
  });

  it("flags a BMI-for-age z-score beyond the WHO -5/+5 plausibility range", async () => {
    const r = await integratedSchoolAgeScreen({ sex: "male", age: { age_years: 9 }, bmi: 55 }, { fetchBmiForAge: api("obesity") });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.clinical_flags.some((f) => f.flag === "data_quality:implausible_z_score")).toBe(true);
  });

  it("STRONGkids high risk with normal anthropometry -> priority dietetic referral", async () => {
    const r = await integratedSchoolAgeScreen(
      {
        sex: "male",
        age: { age_years: 8 },
        muac_mm: 170,
        bmi: 15.5,
        measurement_context: "hospital",
        strongkids: {
          clinical_assessment_poor_nutritional_status: true,
          high_risk_disease: true,
          reduced_intake_or_losses: true,
          weight_loss_or_poor_gain: true,
        },
      },
      { fetchBmiForAge: api("normal") }
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.screening.tools_administered).toEqual(["strongkids"]);
    expect(r.result.risk.screening_risk_summary).toBe("risk_flagged_by_at_least_one_tool");
    expect(r.result.recommended_action.urgency).toBe("priority");
  });

  it("notes that STRONGkids is hospital-validated when used outside a hospital", async () => {
    const r = await integratedSchoolAgeScreen(
      {
        sex: "male",
        age: { age_years: 8 },
        muac_mm: 170,
        strongkids: { clinical_assessment_poor_nutritional_status: false, high_risk_disease: false, reduced_intake_or_losses: false, weight_loss_or_poor_gain: false },
      },
      { fetchBmiForAge: api("normal") }
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.limitations.join(" ")).toMatch(/hospitalized paediatric/);
  });

  it("always states what it does not assess (no 5-19y height-for-age reference) and carries the Malawi protocol TODO", async () => {
    const r = await integratedSchoolAgeScreen({ sex: "male", age: { age_years: 8 }, muac_mm: 170 }, { fetchBmiForAge: api("normal") });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.limitations.join(" ")).toMatch(/Height-for-age/);
    expect(r.result.referral.todo_malawi_protocol).toMatch(/TODO/);
  });
});
