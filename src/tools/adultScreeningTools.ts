import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, safeTool } from "../utils/toolResult.js";
import { classifyAdult, NACS_DISCLAIMER, type NacsAdultResult } from "./nacsClassificationTools.js";
import { estimateStatureFromUlna, estimateStatureFromKneeHeight } from "./statureEstimationTools.js";
import { estimateWeightPersons65Plus, estimateWeightFromKneeHeightAndMac } from "./weightEstimationTools.js";
import {
  resolveAge,
  ageSchema,
  type AgeInput,
  type ResolvedAge,
  type DataQualityFlag,
  type ClinicalFlag,
  type MeasurementContext,
} from "./under5MalnutritionScreeningTools.js";

/**
 * Adult (18+, non-pregnant/non-postpartum) malnutrition screening workflow:
 * adult men and non-pregnant women, including older adults.
 *
 * ORCHESTRATION layer — reuses classifyAdult() from
 * nacsClassificationTools.ts (NACS User's Guide Module 2: edema, MUAC, BMI,
 * confirmed >10% weight loss) and adds:
 *   - BMI calculated from weight + height (unrounded), with data-quality checks
 *   - the BAPEN 'MUST' (Malnutrition Universal Screening Tool) as an OPTIONAL
 *     second, separate risk axis — deterministic scoring only
 *   - a deterministic referral/action ladder
 * Same three-layer split as the under-5 and pregnant/postpartum modules; see
 * those files. Layer 3 (a conversational agent such as adultScreening.js in
 * thanzi-coach-whatsapp) must treat every classification and
 * recommended_action as authoritative, never recompute/override/soften them,
 * and never invent measurements.
 *
 * Two axes are kept SEPARATE (anthropometric NACS status vs MUST risk)
 * because they measure different things and can legitimately disagree —
 * mirroring the under-5 module.
 *
 * Height that cannot be measured standing (bedridden, older, contractures):
 * pass ulna_length_cm (preferred — a lookup table, no race needed) or
 * knee_height_cm + race (Lee & Nieman equations) and the height is estimated
 * with the same functions as the stature_from_* tools. Only used when
 * height_cm is not given; always labelled as an estimate in the output
 * (measurements.height_source, a clinical flag, limitations, and — for knee
 * height, whose equations publish an error — the BMI range that error implies).
 * A doubtful source-table cell is refused rather than used silently.
 *
 * Weight that cannot be measured: only when the caller sets
 * estimate_weight_if_missing = true (an explicit opt-in — never done
 * implicitly) and weight_kg is absent, weight is estimated from muac_mm plus
 * calf_circumference_cm (65+; optional subscapular_skinfold_mm and
 * knee_height_cm) and/or knee_height_cm + race (Lee & Nieman, up to 80
 * years), using the same functions as the weight_* tools; the equation with
 * the lowest standard error wins. THE ERRORS ARE LARGE (about 4-5 kg for the
 * 65+ set, 7-14.5 kg for the race-specific knee-height set), so an estimated
 * weight is always labelled, carries its standard error, and produces a BMI
 * range; a range that straddles a NACS BMI cut-off raises
 * bmi_classification_uncertain. It is used for BMI (and so MUST) only —
 * MUAC, oedema and weight-loss findings never depend on it.
 *
 * Older adults (65+): NACS adult cut-offs are NOT age-adjusted, and the
 * MUAC cut-offs are suggestions rather than a WHO standard. GLIM (see
 * glim_malnutrition_diagnosis in this server) uses higher BMI thresholds
 * for people 70 and older. A limitation note says so; classification is not
 * altered.
 *
 * MALAWI / DEPLOYMENT NOTE: referral wording is generic/CMAM-aligned, NOT the
 * specific Malawi Ministry of Health protocol — see TODO(malawi-protocol).
 *
 * Screening/decision-support prototype only — not a diagnostic device.
 */

const MODULE_DISCLAIMER =
  "Screening/decision-support tool only. Classification is produced by deterministic NACS rules " +
  "(edema/MUAC/BMI/confirmed weight loss) and, if supplied, the BAPEN MUST score. This is not a diagnosis and " +
  "not a substitute for assessment and management by a qualified health worker. Adult MUAC cut-offs are " +
  "suggestions, not a WHO standard. Referral wording is generic/CMAM-aligned, not the specific Malawi Ministry " +
  "of Health protocol — see the todo_malawi_protocol field.";

const ADULT_MIN_MONTHS = 18 * 12;
const OLDER_ADULT_YEARS = 65; // conventional threshold; only triggers a limitation note, never changes a classification

/** NACS adult BMI cut-offs (kg/m2) — used only to tell when an estimated height makes a BMI category uncertain. */
const NACS_ADULT_BMI_CUTOFFS = [16.0, 18.5, 25.0, 30.0];

/** Gross data-entry sanity bounds only (unit/typo catching), NOT clinical thresholds. */
const PLAUSIBILITY_BOUNDS = {
  weight_kg: { min: 20, max: 300 },
  height_cm: { min: 100, max: 230 },
  muac_mm: { min: 100, max: 500 },
  bmi: { min: 8, max: 80 },
} as const;

function checkPlausibility(field: keyof typeof PLAUSIBILITY_BOUNDS, value: number | undefined): DataQualityFlag[] {
  if (value === undefined) return [];
  const b = PLAUSIBILITY_BOUNDS[field];
  if (value < b.min || value > b.max) {
    return [
      {
        field,
        issue: "implausible_value",
        detail: `${field} = ${value} is outside the plausible data-entry range (${b.min}-${b.max}). Check for a unit or transcription error before using this value.`,
      },
    ];
  }
  return [];
}

// ─────────────────────────────────────────────────────────────────────────
// MUST — Malnutrition Universal Screening Tool
// ─────────────────────────────────────────────────────────────────────────

export type MustWeightLossBand = "lt_5_percent" | "5_to_10_percent" | "gt_10_percent";

export interface MustInput {
  /** Body mass index, kg/m2 (calculated by the integrated tool from weight + height when not supplied). */
  bmi: number;
  /** Unplanned weight loss over the past 3-6 months. */
  weight_loss_band: MustWeightLossBand;
  /** Acutely ill AND there has been or is likely to be no nutritional intake for more than 5 days. */
  acute_disease_no_intake_over_5_days: boolean;
}

export interface MustResult {
  responses: MustInput;
  component_scores: { bmi: number; weight_loss: number; acute_disease: number };
  total_score: number;
  risk_category: "low" | "medium" | "high";
  explanation: string;
  source: string;
  age_applicability: string;
}

/**
 * MUST (BAPEN). Source: Elia M (ed). The 'MUST' Report. BAPEN, 2003;
 * validation: Stratton RJ, Hackston A, Longmore D, et al. Br J Nutr.
 * 2004;92(5):799-808.
 *   Step 1 BMI:          > 20 = 0;  18.5-20 = 1;  < 18.5 = 2
 *   Step 2 weight loss (past 3-6 months): < 5% = 0;  5-10% = 1;  > 10% = 2
 *   Step 3 acute disease effect: 2 if acutely ill AND no nutritional intake
 *          (or likely none) for > 5 days, else 0
 *   Step 4 total: 0 = low risk, 1 = medium risk, >= 2 = high risk
 * Adults only. The MUAC-based BMI estimate MUST allows when height/weight
 * cannot be measured is NOT implemented here — BMI must be supplied.
 */
export function mustScreen(input: MustInput): MustResult {
  const bmi = input.bmi > 20 ? 0 : input.bmi >= 18.5 ? 1 : 2;
  const weightLoss = input.weight_loss_band === "lt_5_percent" ? 0 : input.weight_loss_band === "5_to_10_percent" ? 1 : 2;
  const acute = input.acute_disease_no_intake_over_5_days ? 2 : 0;
  const total = bmi + weightLoss + acute;
  const risk: MustResult["risk_category"] = total >= 2 ? "high" : total === 1 ? "medium" : "low";
  return {
    responses: input,
    component_scores: { bmi, weight_loss: weightLoss, acute_disease: acute },
    total_score: total,
    risk_category: risk,
    explanation: `MUST score ${total} (BMI ${bmi}, weight loss ${weightLoss}, acute disease ${acute}) -> ${risk} risk (0 = low, 1 = medium, >= 2 = high).`,
    source: "BAPEN 'MUST' (Elia 2003); Stratton RJ et al. Br J Nutr. 2004;92(5):799-808.",
    age_applicability: "adults (18+)",
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Integrated adult screen
// ─────────────────────────────────────────────────────────────────────────

export interface AdultIntegratedScreenInput {
  sex: "male" | "female";
  age: AgeInput;
  weight_kg?: number;
  height_cm?: number;
  /** Alternative to weight_kg + height_cm. Ignored (and flagged) if both weight and height are given. */
  bmi?: number;
  muac_mm?: number;
  edema?: boolean;
  confirmed_weight_loss_over_10_percent?: boolean;
  /** Ulna length (olecranon to ulnar styloid midpoint), cm. Estimates height when height_cm is not given. Table range 18.5-32.0. */
  ulna_length_cm?: number;
  /** Knee height, cm. Estimates height when height_cm and a usable ulna_length_cm are not given; needs `race`. */
  knee_height_cm?: number;
  /** Only used with knee_height_cm — the Lee & Nieman equations are race-specific. */
  race?: "black" | "white";
  /** Calf circumference, cm — one of the inputs of the 65+ weight equations. Used only when weight is estimated. */
  calf_circumference_cm?: number;
  /** Subscapular skinfold, mm — improves the 65+ weight equations. Used only when weight is estimated. */
  subscapular_skinfold_mm?: number;
  /** Explicit opt-in: estimate weight (from muac_mm + calf and/or knee_height_cm + race) when weight_kg is absent. */
  estimate_weight_if_missing?: boolean;
  /** Set true for a pregnant/postpartum woman — declined; use pregnant_postpartum_integrated_screen. */
  pregnant_or_postpartum?: boolean;
  measurement_context?: MeasurementContext;
  must?: { weight_loss_band: MustWeightLossBand; acute_disease_no_intake_over_5_days: boolean };
}

export interface AdultIntegratedScreenResult {
  status: "success";
  person: { sex: "male" | "female"; age_years: number; age_source: ResolvedAge["source"]; older_adult: boolean };
  measurement_context: MeasurementContext;
  measurement_quality: { data_quality_flags: DataQualityFlag[]; missing_measurements: string[] };
  measurements: {
    bmi: number | null;
    weight_kg: number | null;
    weight_source: "measured" | "estimated_65plus" | "estimated_knee_height_mac" | null;
    /** Standard error of the weight estimate, kg (estimated weight only). */
    weight_error_kg?: number;
    weight_estimate?: { formula: string; see_kg: number; alternatives: Array<{ estimated_weight_kg: number; see_kg: number; formula: string }> };
    height_cm: number | null;
    height_source: "measured" | "ulna_length" | "knee_height" | null;
    /** Published error of the height estimate (knee height only), cm. */
    height_error_cm?: number;
    /** BMI allowing +/- the published error of each estimated input (weight and/or knee-height-based height). */
    bmi_range_from_estimate_error?: { low: number; high: number };
  };
  nacs_classification: NacsAdultResult | null;
  nacs_classification_skipped_reason: string | null;
  screening: { tools_administered: string[]; tools_skipped: Array<{ tool: string; reason: string }>; must: MustResult | null };
  risk: { anthropometric_malnutrition_status: string; screening_risk_summary: string };
  clinical_flags: ClinicalFlag[];
  recommended_action: { urgency: "urgent" | "priority" | "routine"; action: string };
  referral: { pathway: string; todo_malawi_protocol: string };
  explanation: string;
  limitations: string[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function integratedAdultScreen(
  input: AdultIntegratedScreenInput
): { ok: true; result: AdultIntegratedScreenResult } | { ok: false; error: string } {
  const context = input.measurement_context ?? "community";

  if (input.pregnant_or_postpartum) {
    return {
      ok: false,
      error: "This tool is for non-pregnant, non-postpartum adults. Use pregnant_postpartum_integrated_screen instead.",
    };
  }

  const ageOutcome = resolveAge(input.age);
  if (!ageOutcome.ok) return { ok: false, error: ageOutcome.error };
  const { ageMonths, source: ageSource } = ageOutcome.age;
  if (ageMonths < ADULT_MIN_MONTHS) {
    return {
      ok: false,
      error:
        `Age (${round1(ageMonths / 12)} years) is below the 18-year lower bound of this module. ` +
        "Use school_age_integrated_screen for 5-17 years, or under5_integrated_screen for 0-59 months.",
    };
  }
  const ageYears = ageMonths / 12;
  const olderAdult = ageYears >= OLDER_ADULT_YEARS;

  const { weight_kg, height_cm, muac_mm, edema, confirmed_weight_loss_over_10_percent } = input;
  const flags: DataQualityFlag[] = [
    ...checkPlausibility("weight_kg", weight_kg),
    ...checkPlausibility("height_cm", height_cm),
    ...checkPlausibility("muac_mm", muac_mm),
  ];

  // ── Height: a measured standing height always wins; otherwise estimate it (ulna first, then knee height) ──
  let heightCm: number | undefined = height_cm;
  let heightSource: AdultIntegratedScreenResult["measurements"]["height_source"] = height_cm !== undefined ? "measured" : null;
  let heightErrorCm: number | undefined;
  if (height_cm !== undefined) {
    if (input.ulna_length_cm !== undefined || input.knee_height_cm !== undefined) {
      flags.push({
        field: "height_cm",
        issue: "ignored",
        detail: "ulna_length_cm / knee_height_cm were ignored because a measured height_cm was provided.",
      });
    }
  } else {
    if (input.ulna_length_cm !== undefined) {
      const est = estimateStatureFromUlna(input.sex, ageYears, input.ulna_length_cm);
      if (!est.ok) {
        flags.push({ field: "ulna_length_cm", issue: "height_estimate_unavailable", detail: est.error });
      } else if (est.unreliable_reason) {
        flags.push({
          field: "ulna_length_cm",
          issue: "height_estimate_unavailable",
          detail: `Height was NOT estimated from this ulna length: ${est.unreliable_reason}`,
        });
      } else {
        heightCm = est.estimated_height_cm;
        heightSource = "ulna_length";
      }
    }
    if (heightCm === undefined && input.knee_height_cm !== undefined) {
      if (input.race === undefined) {
        flags.push({
          field: "knee_height_cm",
          issue: "height_estimate_unavailable",
          detail: "knee_height_cm was not used because race is required by the Lee & Nieman equations and was not provided.",
        });
      } else {
        const est = estimateStatureFromKneeHeight(input.race, input.sex, ageYears, input.knee_height_cm);
        if (!est.ok) {
          flags.push({ field: "knee_height_cm", issue: "height_estimate_unavailable", detail: est.error });
        } else {
          heightCm = est.estimated_height_cm;
          heightSource = "knee_height";
          heightErrorCm = est.error_cm;
        }
      }
    }
  }
  const heightEstimated = heightSource === "ulna_length" || heightSource === "knee_height";
  const finalHeightCm = heightCm; // const alias so TypeScript can narrow it below

  // ── Weight: a measured weight always wins; otherwise, only on explicit opt-in, estimate it ──
  let weightKg: number | undefined = weight_kg;
  let weightSource: AdultIntegratedScreenResult["measurements"]["weight_source"] = weight_kg !== undefined ? "measured" : null;
  let weightErrorKg: number | undefined;
  let weightEstimate: AdultIntegratedScreenResult["measurements"]["weight_estimate"];
  const calfCm = input.calf_circumference_cm;
  const ssfMm = input.subscapular_skinfold_mm;
  if (weight_kg !== undefined) {
    if (calfCm !== undefined || ssfMm !== undefined) {
      flags.push({
        field: "weight_kg",
        issue: "ignored",
        detail: "calf_circumference_cm / subscapular_skinfold_mm were ignored because a measured weight_kg was provided.",
      });
    }
  } else if (input.estimate_weight_if_missing) {
    const muacCm = muac_mm !== undefined ? muac_mm / 10 : undefined;
    type Candidate = { method: "estimated_65plus" | "estimated_knee_height_mac"; estimated_weight_kg: number; see_kg: number; formula: string };
    const candidates: Candidate[] = [];
    const reasons: string[] = [];
    if (muacCm === undefined) {
      reasons.push("arm circumference (muac_mm) is required for every weight equation");
    } else {
      if (calfCm !== undefined) {
        if (ageYears >= 65) {
          for (const e of estimateWeightPersons65Plus(input.sex, { muac: muacCm, cc: calfCm, ssf: ssfMm, kh: input.knee_height_cm })) {
            candidates.push({ method: "estimated_65plus", estimated_weight_kg: e.estimated_weight_kg, see_kg: e.see_kg, formula: e.formula });
          }
        } else {
          reasons.push("the calf-circumference equations are for people 65 and older");
        }
      }
      if (input.knee_height_cm !== undefined) {
        if (input.race === undefined) {
          reasons.push("knee_height_cm was not used for weight because race is required by the Lee & Nieman equations and was not provided");
        } else {
          const r = estimateWeightFromKneeHeightAndMac({
            sex: input.sex,
            race: input.race,
            age_years: ageYears,
            knee_height_cm: input.knee_height_cm,
            mid_arm_circumference_cm: muacCm,
          });
          if (r.ok) candidates.push({ method: "estimated_knee_height_mac", estimated_weight_kg: r.estimated_weight_kg, see_kg: r.see_kg, formula: r.formula });
          else reasons.push(r.error);
        }
      }
    }
    candidates.sort((a, b) => a.see_kg - b.see_kg);
    const best = candidates[0];
    if (!best) {
      flags.push({
        field: "weight_kg",
        issue: "weight_estimate_unavailable",
        detail: `Weight could not be estimated: ${reasons.length > 0 ? reasons.join("; ") : "not enough measurements (65+: arm + calf; any adult up to 80: arm + knee height + race)"}.`,
      });
    } else if (best.estimated_weight_kg < PLAUSIBILITY_BOUNDS.weight_kg.min || best.estimated_weight_kg > PLAUSIBILITY_BOUNDS.weight_kg.max) {
      flags.push({
        field: "weight_kg",
        issue: "weight_estimate_unavailable",
        detail: `The estimated weight (${round1(best.estimated_weight_kg)} kg) is outside the plausible range (${PLAUSIBILITY_BOUNDS.weight_kg.min}-${PLAUSIBILITY_BOUNDS.weight_kg.max}); it was not used. Check the circumference measurements and units.`,
      });
    } else {
      weightKg = best.estimated_weight_kg;
      weightSource = best.method;
      weightErrorKg = best.see_kg;
      weightEstimate = {
        formula: best.formula,
        see_kg: best.see_kg,
        alternatives: candidates.slice(1).map((c) => ({ estimated_weight_kg: c.estimated_weight_kg, see_kg: c.see_kg, formula: c.formula })),
      };
    }
  }
  const weightEstimated = weightSource === "estimated_65plus" || weightSource === "estimated_knee_height_mac";
  const finalWeightKg = weightKg; // const alias so TypeScript can narrow it below

  // ── BMI: weight + height take precedence over a pre-computed BMI ──
  let bmi: number | undefined;
  const hasWeightHeight = finalWeightKg !== undefined && finalHeightCm !== undefined;
  if (hasWeightHeight) {
    const m = finalHeightCm / 100;
    bmi = finalWeightKg / (m * m); // unrounded on purpose: rounding first can flip a borderline result
    if (input.bmi !== undefined) {
      flags.push({
        field: "bmi",
        issue: "ignored",
        detail: "bmi was ignored because weight and height were both available; BMI was calculated from those instead.",
      });
    }
  } else if (input.bmi !== undefined) {
    bmi = input.bmi;
  }
  if (bmi !== undefined) {
    if (!(bmi > 0 && Number.isFinite(bmi))) return { ok: false, error: "BMI is not a positive number — check weight_kg / height_cm / bmi." };
    flags.push(...checkPlausibility("bmi", bmi));
  }

  // For estimated inputs whose equations publish an error (weight SEE, knee-height stature error), show the BMI
  // range those errors imply and say so when it straddles a NACS cut-off — the BMI category is then genuinely uncertain.
  let bmiRange: { low: number; high: number } | undefined;
  let bmiCategoryUncertain = false;
  const weightErr = weightEstimated ? weightErrorKg : undefined;
  const heightErr = heightSource === "knee_height" ? heightErrorCm : undefined;
  if (hasWeightHeight && (weightErr !== undefined || heightErr !== undefined)) {
    const w = finalWeightKg;
    const h = finalHeightCm;
    const low = Math.max(w - (weightErr ?? 0), 0.1) / (((h + (heightErr ?? 0)) / 100) ** 2);
    const high = (w + (weightErr ?? 0)) / (((h - (heightErr ?? 0)) / 100) ** 2);
    bmiRange = { low: round1(low), high: round1(high) };
    bmiCategoryUncertain = NACS_ADULT_BMI_CUTOFFS.some((c) => c > low && c <= high);
  }

  const missing: string[] = [];
  if (bmi === undefined) missing.push(finalWeightKg === undefined && heightCm === undefined ? "weight_kg + height_cm (or bmi)" : finalWeightKg === undefined ? "weight_kg" : "height_cm");
  if (muac_mm === undefined) missing.push("muac_mm");
  if (edema === undefined) missing.push("edema");
  if (confirmed_weight_loss_over_10_percent === undefined) missing.push("confirmed_weight_loss_over_10_percent");

  // ── NACS adult classification (reused engine). BMI is passed unrounded. ──
  const nacsHasInput =
    edema !== undefined || muac_mm !== undefined || bmi !== undefined || confirmed_weight_loss_over_10_percent !== undefined;
  const nacs: NacsAdultResult | null = nacsHasInput
    ? classifyAdult({ edema, muac_mm, bmi, confirmed_weight_loss_over_10_percent })
    : null;
  // classifyAdult echoes BMI via toString(); show a tidy 1-decimal value to the reader instead of 22.857142857142858.
  if (nacs) {
    for (const ind of nacs.indicators) if (ind.indicator === "bmi" && bmi !== undefined) ind.value = String(round1(bmi));
  }
  const nacsSkipped = nacs
    ? null
    : "No measurement was provided (need MUAC, oedema, confirmed weight loss, or weight + height / BMI).";
  const classifiable = nacs !== null && nacs.indicators.length > 0;

  // ── optional MUST ──
  const toolsAdministered: string[] = [];
  const toolsSkipped: Array<{ tool: string; reason: string }> = [];
  let must: MustResult | null = null;
  if (!input.must) {
    toolsSkipped.push({ tool: "must", reason: "Not administered: no responses were provided." });
  } else if (bmi === undefined) {
    toolsSkipped.push({ tool: "must", reason: "Not administered: MUST needs a BMI (weight + height, or bmi) and none was provided." });
  } else {
    must = mustScreen({ bmi, ...input.must });
    toolsAdministered.push("must");
  }
  const mustRisk = must !== null && must.risk_category !== "low";

  const limitations: string[] = [
    "This is a screening/decision-support prototype, not a diagnostic device. All findings should be confirmed and acted on by a qualified health worker.",
    "NACS adult MUAC cut-offs are suggestions based on current practice, not a WHO standard, and the cut-offs are not adjusted for age, sex, or oedema-free weight.",
    "Referral pathway wording is generic/CMAM-aligned; it must be replaced with the current Malawi Ministry of Health protocol before real-world deployment — see referral.todo_malawi_protocol.",
  ];
  if (heightEstimated) {
    limitations.push(
      `Height (${Math.round(heightCm as number)} cm) was ESTIMATED from ${heightSource === "ulna_length" ? "ulna length" : "knee height"}, not measured. ` +
        "BMI, the NACS BMI classification and the MUST BMI score all inherit that uncertainty; MUAC, oedema and weight-loss findings do not depend on height." +
        (heightSource === "ulna_length" ? " The ulna table publishes no error figure." : ` The equation's published error is +/-${heightErrorCm} cm.`)
    );
  }
  if (weightEstimated) {
    limitations.push(
      `Weight (${round1(finalWeightKg as number)} kg) was ESTIMATED (Lee & Nieman, ${weightSource === "estimated_65plus" ? "65+ equations" : "race-specific knee-height and arm-circumference equation"}), not measured. ` +
        `The equation's standard error is +/-${weightErrorKg} kg, which is large relative to the BMI cut-offs. BMI, the NACS BMI classification and the MUST BMI score ` +
        "all inherit that uncertainty; MUAC, oedema and weight-loss findings do not depend on weight. Weigh the person as soon as a scale is available."
    );
  }
  if (bmiRange) {
    limitations.push(`Allowing for the published error of the estimated input(s), BMI could be anywhere from ${bmiRange.low} to ${bmiRange.high}.`);
  }
  if (olderAdult) {
    limitations.push(
      `Person is ${OLDER_ADULT_YEARS}+ years: NACS adult BMI/MUAC cut-offs are not age-adjusted and can under-detect malnutrition in older adults. ` +
        "GLIM (glim_malnutrition_diagnosis) uses higher BMI thresholds from 70 years; consider it alongside this screen."
    );
  }
  if (ageYears < 19) {
    limitations.push(
      "Age 18 to under 19: NACS adult cut-offs are applied (NACS groups 18+ as adults). bmi_for_age_classify (WHO 2007, to 19 years) can be used as a cross-check."
    );
  }
  if (must && context === "nutrition_rehabilitation") {
    limitations.push("MUST is a general adult screening tool; in a nutrition rehabilitation setting treat anthropometric classification as primary.");
  }

  // ── clinical flags ──
  const clinicalFlags: ClinicalFlag[] = [];
  for (const dq of flags) clinicalFlags.push({ flag: `data_quality:${dq.issue}`, detail: dq.detail });
  if (nacs) {
    for (const ind of nacs.indicators) {
      if (ind.classification !== "normal") {
        clinicalFlags.push({ flag: `nacs_${ind.indicator}:${ind.classification}`, detail: `${ind.indicator} = ${ind.value} -> ${ind.classification} (${ind.cutoffApplied}).` });
      }
    }
  }
  for (const m of missing) clinicalFlags.push({ flag: `missing_measurement:${m}`, detail: `${m} was not provided — not invented or substituted.` });
  if (heightEstimated) {
    clinicalFlags.push({
      flag: "bmi_from_estimated_height",
      detail: `Height estimated from ${heightSource === "ulna_length" ? "ulna length" : "knee height"} (${Math.round(heightCm as number)} cm) — BMI-based findings are estimates.`,
    });
  }
  if (weightEstimated) {
    clinicalFlags.push({
      flag: "bmi_from_estimated_weight",
      detail: `Weight estimated (${round1(finalWeightKg as number)} kg, standard error +/-${weightErrorKg} kg) — BMI-based findings are estimates.`,
    });
  }
  if (bmiCategoryUncertain && bmiRange) {
    clinicalFlags.push({
      flag: "bmi_classification_uncertain",
      detail: `The BMI range implied by the published error of the estimated input(s) (${bmiRange.low}-${bmiRange.high}) straddles a NACS BMI cut-off, so the BMI category could differ.`,
    });
  }
  if (mustRisk && must) clinicalFlags.push({ flag: `screening_risk:must:${must.risk_category}`, detail: "must flagged nutrition risk." });
  if (olderAdult) clinicalFlags.push({ flag: "older_adult", detail: `Age ${round1(ageYears)} years: see limitations on age-adjustment of adult cut-offs.` });

  // ── risk axes + action ladder (deterministic; most severe wins) ──
  // TODO(malawi-protocol): replace this generic, CMAM-aligned ladder with the
  // current Malawi Ministry of Health referral protocol for adults (facility
  // types, follow-up intervals, commodity guidance) before real-world use.
  const anthropometricStatus = classifiable && nacs ? nacs.overallMalnutritionClassification : "not_classified_insufficient_data";
  const hasOverweight = nacs?.indicators.some((i) => i.classification === "overweight" || i.classification === "obesity") ?? false;

  let urgency: AdultIntegratedScreenResult["recommended_action"]["urgency"];
  let action: string;
  if (anthropometricStatus === "severe") {
    urgency = "urgent";
    action =
      "Urgent referral to a qualified health worker for assessment and management of suspected severe acute malnutrition in this adult, per national protocol — same day if possible.";
  } else if (anthropometricStatus === "moderate") {
    urgency = "priority";
    action = "Refer for nutrition assessment and supplementary feeding / nutrition counselling for suspected moderate acute malnutrition.";
  } else if (mustRisk && must) {
    urgency = "priority";
    action = `Anthropometry does not currently indicate acute malnutrition, but MUST indicates ${must.risk_category} nutrition risk — refer for further dietetic assessment.`;
  } else if (anthropometricStatus === "not_classified_insufficient_data") {
    urgency = "routine";
    action = "Not enough measurements to classify nutritional status. Measure MUAC, check for bilateral pitting oedema, and record weight and height, then screen again.";
  } else if (hasOverweight) {
    urgency = "routine";
    action = "No acute malnutrition identified, but BMI is above the normal range (overweight/obesity) — nutrition and physical-activity counselling and routine follow-up.";
  } else {
    urgency = "routine";
    action = "No acute malnutrition identified on this screening — continue routine nutrition counselling and follow-up.";
  }

  const screeningSummary = must === null ? "not_administered" : mustRisk ? "risk_flagged_by_at_least_one_tool" : "no_risk_flagged";

  const parts: string[] = [`Adult: ${round1(ageYears)} years, ${input.sex}.`];
  if (weightEstimated) parts.push(`Weight estimated: ${round1(finalWeightKg as number)} kg (standard error +/-${weightErrorKg} kg; not measured).`);
  if (heightEstimated) parts.push(`Height estimated from ${heightSource === "ulna_length" ? "ulna length" : "knee height"}: ${Math.round(heightCm as number)} cm (not measured).`);
  if (nacs) {
    for (const ind of nacs.indicators) parts.push(`${ind.indicator} = ${ind.value} -> ${ind.classification} (${ind.cutoffApplied}).`);
    if (nacs.indicators.length > 0) parts.push(`Overall NACS acute-malnutrition classification: ${nacs.overallMalnutritionClassification}.`);
  } else if (nacsSkipped) {
    parts.push(`NACS classification not computed: ${nacsSkipped}`);
  }
  if (must) parts.push(must.explanation);
  parts.push(`Recommended action (${urgency}): ${action}`);

  return {
    ok: true,
    result: {
      status: "success",
      person: { sex: input.sex, age_years: round1(ageYears), age_source: ageSource, older_adult: olderAdult },
      measurement_context: context,
      measurement_quality: { data_quality_flags: flags, missing_measurements: missing },
      measurements: {
        bmi: bmi !== undefined ? round1(bmi) : null,
        weight_kg: finalWeightKg !== undefined ? round1(finalWeightKg) : null,
        weight_source: weightSource,
        ...(weightErrorKg !== undefined && weightEstimated ? { weight_error_kg: weightErrorKg } : {}),
        ...(weightEstimate ? { weight_estimate: weightEstimate } : {}),
        height_cm: heightCm !== undefined ? Math.round(heightCm * 10) / 10 : null,
        height_source: heightSource,
        ...(heightErrorCm !== undefined ? { height_error_cm: heightErrorCm } : {}),
        ...(bmiRange ? { bmi_range_from_estimate_error: bmiRange } : {}),
      },
      nacs_classification: nacs,
      nacs_classification_skipped_reason: nacsSkipped,
      screening: { tools_administered: toolsAdministered, tools_skipped: toolsSkipped, must },
      risk: { anthropometric_malnutrition_status: anthropometricStatus, screening_risk_summary: screeningSummary },
      clinical_flags: clinicalFlags,
      recommended_action: { urgency, action },
      referral: {
        pathway: action,
        todo_malawi_protocol:
          "TODO: replace with the current Malawi Ministry of Health referral protocol for adults (specific facility types, follow-up intervals, commodity guidance). Not present in this repository, so not invented here.",
      },
      explanation: parts.join(" "),
      limitations,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// MCP tool registration (Layer 2 — thin wrappers, no clinical logic here)
// ─────────────────────────────────────────────────────────────────────────

const mustSchema = {
  weight_loss_band: z
    .enum(["lt_5_percent", "5_to_10_percent", "gt_10_percent"])
    .describe("Unplanned weight loss in the past 3-6 months: < 5%, 5-10%, or > 10%"),
  acute_disease_no_intake_over_5_days: z
    .boolean()
    .describe("Acutely ill AND there has been or is likely to be no nutritional intake for more than 5 days"),
};

export function registerAdultScreeningTools(server: McpServer): void {
  server.registerTool(
    "must_screen",
    {
      title: "MUST — Malnutrition Universal Screening Tool (adults)",
      description:
        "Deterministic BAPEN MUST score for an adult: BMI score (> 20 = 0, 18.5-20 = 1, < 18.5 = 2) + unplanned " +
        "weight-loss score over 3-6 months (< 5% = 0, 5-10% = 1, > 10% = 2) + acute-disease score (2 if acutely ill " +
        "with no nutritional intake for > 5 days) -> 0 low, 1 medium, >= 2 high risk. Supply the BMI directly (the " +
        "MUAC-based BMI estimate is not implemented). For a fuller workflow (NACS classification + referral action) " +
        "use adult_integrated_screen.",
      inputSchema: {
        bmi: z.number().positive().describe("BMI in kg/m^2"),
        ...mustSchema,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("must_screen", async (args) => ok(mustScreen(args), { disclaimer: MODULE_DISCLAIMER }))
  );

  server.registerTool(
    "adult_integrated_screen",
    {
      title: "Adult (18+) Integrated Malnutrition Screening",
      description:
        "Orchestration tool for malnutrition screening of adults 18 years and older who are NOT pregnant or " +
        "postpartum — men and non-pregnant women, including older adults (for pregnant/postpartum women use " +
        "pregnant_postpartum_integrated_screen; for 5-17 years use school_age_integrated_screen; for 0-59 months use " +
        "under5_integrated_screen). Takes the person's details ONCE and combines NACS classification (bilateral " +
        "oedema, MUAC, BMI calculated from weight_kg + height_cm, confirmed >10% weight loss) with an optional BAPEN " +
        "MUST risk score on a SEPARATE axis. Returns per-indicator classifications (including overweight/obesity), " +
        "an overall NACS status, clinical flags, a deterministic recommended action/referral, an evidence-traceable " +
        "explanation and limitations. Provide age via age_years, age_months, age_days, or date_of_birth + " +
        "assessment_date. If standing height cannot be measured, give ulna_length_cm (or knee_height_cm + race) and the " +
        "height is estimated and clearly labelled as an estimate. If the person cannot be weighed, set " +
        "estimate_weight_if_missing with muac_mm and calf_circumference_cm (65+) and/or knee_height_cm + race: weight is then " +
        "estimated (large standard error, always labelled, BMI reported as a range). The AI layer calling this tool MUST treat its output as authoritative and MUST NOT " +
        "recompute, override, or soften any classification, and MUST NOT invent measurements the caller did not supply.",
      inputSchema: {
        sex: z.enum(["male", "female"]),
        ...ageSchema,
        weight_kg: z.number().positive().optional(),
        height_cm: z.number().positive().optional(),
        bmi: z.number().positive().optional().describe("Only if weight_kg and height_cm are not available"),
        muac_mm: z.number().positive().optional(),
        edema: z.boolean().optional().describe("Bilateral pitting oedema present"),
        confirmed_weight_loss_over_10_percent: z.boolean().optional().describe("Confirmed unintentional weight loss >10% since last visit"),
        ulna_length_cm: z
          .number()
          .positive()
          .optional()
          .describe("Ulna length in cm (point of the elbow to the midpoint of the wrist bone). Estimates height when height_cm is not given. Table range 18.5-32.0."),
        knee_height_cm: z.number().positive().optional().describe("Knee height in cm. Estimates height when height_cm and a usable ulna_length_cm are not given; needs race."),
        race: z.enum(["black", "white"]).optional().describe("Only used with knee_height_cm (Lee & Nieman equations are race-specific)"),
        calf_circumference_cm: z.number().positive().optional().describe("Calf circumference in cm. Used only when weight is estimated (65+ equations)."),
        subscapular_skinfold_mm: z.number().positive().optional().describe("Subscapular skinfold in mm. Used only when weight is estimated (65+ equations)."),
        estimate_weight_if_missing: z
          .boolean()
          .optional()
          .describe(
            "Explicit opt-in. If true and weight_kg is absent, weight is ESTIMATED from muac_mm plus calf_circumference_cm (65+) and/or knee_height_cm + race (up to 80). Estimates carry large standard errors (about 4-14 kg) and are always labelled; BMI is then reported as a range."
          ),
        pregnant_or_postpartum: z.boolean().optional().describe("If true the tool declines and points to pregnant_postpartum_integrated_screen"),
        measurement_context: z
          .enum(["community", "health_centre", "nutrition_rehabilitation", "hospital"])
          .optional()
          .describe("Defaults to community"),
        must: z.object(mustSchema).optional().describe("Omit to skip MUST. BMI is taken from weight_kg + height_cm (or bmi)."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("adult_integrated_screen", async (args) => {
      const outcome = integratedAdultScreen({
        sex: args.sex,
        age: {
          age_days: args.age_days,
          age_months: args.age_months,
          age_years: args.age_years,
          date_of_birth: args.date_of_birth,
          assessment_date: args.assessment_date,
        },
        weight_kg: args.weight_kg,
        height_cm: args.height_cm,
        bmi: args.bmi,
        muac_mm: args.muac_mm,
        edema: args.edema,
        confirmed_weight_loss_over_10_percent: args.confirmed_weight_loss_over_10_percent,
        ulna_length_cm: args.ulna_length_cm,
        knee_height_cm: args.knee_height_cm,
        race: args.race,
        calf_circumference_cm: args.calf_circumference_cm,
        subscapular_skinfold_mm: args.subscapular_skinfold_mm,
        estimate_weight_if_missing: args.estimate_weight_if_missing,
        pregnant_or_postpartum: args.pregnant_or_postpartum,
        measurement_context: args.measurement_context,
        must: args.must,
      });
      if (!outcome.ok) {
        return { content: [{ type: "text" as const, text: outcome.error }], isError: true as const };
      }
      return ok(outcome.result, { disclaimer: MODULE_DISCLAIMER, nacs_disclaimer: NACS_DISCLAIMER });
    })
  );
}
