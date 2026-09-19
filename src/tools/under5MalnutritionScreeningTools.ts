import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, safeTool } from "../utils/toolResult.js";
import { computeWhoGrowthZScore } from "./whoGrowthTools.js";
import { classifyChildren0to59m, NACS_DISCLAIMER, type Nacs059mResult } from "./nacsClassificationTools.js";

/**
 * Under-5 (0-59 month) malnutrition screening workflow.
 *
 * This module is an ORCHESTRATION layer over clinical engines that already
 * exist elsewhere in this repository — it does not reimplement WHO z-scores
 * or the NACS edema/MUAC/WHZ classification:
 *   - WHO growth z-scores: computeWhoGrowthZScore() from whoGrowthTools.ts
 *   - Edema/MUAC/WHZ classification (SAM/MAM/normal): classifyChildren0to59m()
 *     from nacsClassificationTools.ts
 * Both are called in-process (same Worker, same request) — not via a second
 * MCP round-trip.
 *
 * What IS new here (nothing in the repo already did this):
 *   - Input validation / data-quality flags for a screening encounter
 *   - The WHO-recommended 0.7cm recumbent-length <-> standing-height
 *     conversion when a child was measured the "wrong" way for their age
 *     (WHO Training Course on Child Growth Assessment, Module B)
 *   - Four hospital-validated pediatric nutrition screening questionnaires
 *     (STRONGkids, PNST, PYMS, STAMP) — deterministic scoring only, no
 *     tool existed for these before
 *   - An integrated orchestration tool that captures a child's data once,
 *     calls the above, and returns a combined, explainable, referral-
 *     oriented result
 *
 * CLINICAL ARCHITECTURE (per the brief this module was built against):
 *   Layer 1 (this file + the two reused modules above): deterministic
 *     calculation, classification, and rule-based referral logic. No LLM
 *     involvement, ever.
 *   Layer 2 (the MCP tools registered at the bottom of this file): expose
 *     Layer 1 as machine-readable, structured tool results.
 *   Layer 3 (NOT in this file): a conversational AI agent that sits above
 *     the MCP server, asks the health worker questions, decides which
 *     tools to call, and explains the structured results in plain/local
 *     language. That agent must treat every classification and
 *     recommended_action produced here as authoritative — it must not
 *     recompute, override, or soften them, and must not invent
 *     measurements the health worker did not provide.
 *
 * MALAWI / DEPLOYMENT NOTE: the referral wording and action ladder below
 * are deliberately generic and CMAM-aligned (Community-based Management of
 * Acute Malnutrition, the WHO/UNICEF framework Malawi's protocol is built
 * on), NOT the specific Malawi Ministry of Health CMAM/NACS guideline
 * document. No Malawi-specific protocol text, facility names, commodity
 * names (e.g. RUTF dosing), or follow-up intervals are present in this
 * repository, so none are invented here. Anywhere the generic logic would
 * need to be replaced with the current Malawi MoH protocol is marked
 * TODO(malawi-protocol) below — treat every such TODO as a configuration
 * requirement before real-world deployment, not a finished clinical rule.
 *
 * Pure calculation/classification — no Chakudya API calls. This is a
 * SCREENING/DECISION-SUPPORT prototype, not a diagnostic device and not a
 * substitute for assessment by a qualified health worker.
 */

const MODULE_DISCLAIMER =
  "Screening/decision-support tool only. All classifications are produced by deterministic rules from " +
  "the WHO Child Growth Standards, the NACS User's Guide (edema/MUAC/WHZ), and the cited published " +
  "screening instruments. This is not a diagnosis and not a substitute for assessment and management " +
  "by a qualified health worker. Referral wording is generic/CMAM-aligned, not the specific Malawi " +
  "Ministry of Health protocol — see TODO(malawi-protocol) notes in tool output for what must be " +
  "confirmed/configured locally before real-world use.";

const AGE_DAYS_UNDER_5 = 59 * 30.4375 + 30.4375; // just past 59 completed months, i.e. the 0-59m window
const RECUMBENT_TO_STANDING_SWITCH_MONTHS = 24;

// ─────────────────────────────────────────────────────────────────────────
// Age resolution
// ─────────────────────────────────────────────────────────────────────────

export interface AgeInput {
  age_days?: number;
  age_months?: number;
  age_years?: number;
  date_of_birth?: string; // ISO YYYY-MM-DD
  assessment_date?: string; // ISO YYYY-MM-DD, defaults to date_of_birth-relative "today" not assumed
}

export interface ResolvedAge {
  ageDays: number;
  ageMonths: number;
  source: "age_days" | "age_months" | "age_years" | "date_of_birth";
}

function parseIsoDate(s: string): Date | null {
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Resolves age from whichever input the caller provided. Never guesses a "today" — assessment_date is
 * required alongside date_of_birth, since this module must not assume when the encounter happened. */
export function resolveAge(input: AgeInput): { ok: true; age: ResolvedAge } | { ok: false; error: string } {
  const { age_days, age_months, age_years, date_of_birth, assessment_date } = input;

  if (age_days !== undefined) {
    return { ok: true, age: { ageDays: age_days, ageMonths: age_days / 30.4375, source: "age_days" } };
  }
  if (age_months !== undefined) {
    return {
      ok: true,
      age: { ageDays: age_months * 30.4375, ageMonths: age_months, source: "age_months" },
    };
  }
  if (age_years !== undefined) {
    return {
      ok: true,
      age: { ageDays: age_years * 365.25, ageMonths: age_years * 12, source: "age_years" },
    };
  }
  if (date_of_birth !== undefined) {
    if (assessment_date === undefined) {
      return {
        ok: false,
        error: "assessment_date is required alongside date_of_birth (the date of this screening encounter).",
      };
    }
    const dob = parseIsoDate(date_of_birth);
    const assess = parseIsoDate(assessment_date);
    if (!dob) return { ok: false, error: `date_of_birth "${date_of_birth}" is not a valid ISO date (YYYY-MM-DD).` };
    if (!assess) return { ok: false, error: `assessment_date "${assessment_date}" is not a valid ISO date (YYYY-MM-DD).` };
    const ageDays = (assess.getTime() - dob.getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays < 0) return { ok: false, error: "assessment_date is before date_of_birth." };
    return { ok: true, age: { ageDays, ageMonths: ageDays / 30.4375, source: "date_of_birth" } };
  }
  return {
    ok: false,
    error: "Provide one of: age_days, age_months, age_years, or date_of_birth (with assessment_date).",
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Data-quality validation (sanity bounds — NOT clinical thresholds)
// ─────────────────────────────────────────────────────────────────────────

/**
 * These are gross data-entry sanity bounds only, wide enough to almost
 * never reject a real (if unusual) measurement. They exist to catch typos
 * / unit errors (e.g. height entered in mm, weight entered in lb), not to
 * express any clinical judgement. Do not confuse with the WHO/SMART
 * z-score plausibility flags below, which ARE a recognized data-quality
 * convention and are cited as such.
 */
const PLAUSIBILITY_BOUNDS = {
  weight_kg: { min: 0.3, max: 40 },
  length_or_height_cm: { min: 25, max: 130 },
  muac_mm: { min: 40, max: 300 },
};

/**
 * WHO/SMART survey data-cleaning flags: z-scores beyond these bounds are
 * treated as likely measurement or data-entry errors rather than true
 * biological extremes, and are conventionally excluded/flagged rather than
 * used to guide individual clinical decisions without re-measurement.
 * Source: WHO Multicentre Growth Reference Study flagging criteria, as
 * implemented in WHO Anthro and commonly used in SMART survey methodology
 * (WAZ outside -6/+5, HAZ outside -6/+6, WHZ outside -5/+5).
 */
const ZSCORE_PLAUSIBILITY: Record<string, { min: number; max: number }> = {
  weight_for_age: { min: -6, max: 5 },
  height_for_age: { min: -6, max: 6 },
  weight_for_length: { min: -5, max: 5 },
  weight_for_height: { min: -5, max: 5 },
};

export interface DataQualityFlag {
  field: string;
  issue: string;
  detail: string;
}

function checkPlausibility(field: keyof typeof PLAUSIBILITY_BOUNDS, value: number | undefined): DataQualityFlag[] {
  if (value === undefined) return [];
  const bound = PLAUSIBILITY_BOUNDS[field];
  if (value < bound.min || value > bound.max) {
    return [
      {
        field,
        issue: "implausible_value",
        detail: `${field} = ${value} is outside the plausible data-entry range (${bound.min}-${bound.max}). Check for a unit or transcription error before using this value.`,
      },
    ];
  }
  return [];
}

// ─────────────────────────────────────────────────────────────────────────
// Anthropometric assessment (Tool 1 core) — reuses computeWhoGrowthZScore
// and classifyChildren0to59m, does not reimplement either.
// ─────────────────────────────────────────────────────────────────────────

export type MeasurementMethod = "recumbent_length" | "standing_height";

export interface Under5AnthropometricInput {
  sex: "male" | "female";
  age: AgeInput;
  weight_kg?: number;
  length_or_height_cm?: number;
  measurement_method?: MeasurementMethod;
  muac_mm?: number;
  edema?: boolean;
}

export interface IndicatorOutcome {
  available: boolean;
  reason_unavailable?: string;
  raw_value?: number;
  z_score?: number;
  percentile?: number;
  classification?: string;
  source_range?: string;
}

export interface Under5AnthropometricResult {
  age_days: number;
  age_months: number;
  age_source: ResolvedAge["source"];
  age_in_scope: boolean;
  sex: "male" | "female";
  measurements: {
    weight_kg: number | null;
    length_or_height_cm: number | null;
    measurement_method_provided: MeasurementMethod | null;
    muac_mm: number | null;
    edema: boolean | null;
  };
  measurement_adjustment: {
    applied: boolean;
    detail: string | null;
  };
  indicators: {
    weight_for_age: IndicatorOutcome;
    height_for_age: IndicatorOutcome;
    weight_for_length_or_height: IndicatorOutcome & { standard_used: "weight_for_length" | "weight_for_height" | null };
    bmi_for_age: IndicatorOutcome;
  };
  nacs_classification: Nacs059mResult | null;
  nacs_classification_skipped_reason: string | null;
  data_quality_flags: DataQualityFlag[];
  missing_measurements: string[];
}

const MISSING = (reason: string): IndicatorOutcome => ({ available: false, reason_unavailable: reason });

/**
 * Core anthropometric assessment. Exported as a pure function so
 * under5_integrated_screen can call it directly without a second tool
 * round-trip, and so it can be unit tested without spinning up the MCP
 * server.
 */
export function assessUnder5Anthropometry(
  input: Under5AnthropometricInput
): { ok: true; result: Under5AnthropometricResult } | { ok: false; error: string } {
  const { sex, age, weight_kg, length_or_height_cm, measurement_method, muac_mm, edema } = input;

  const ageOutcome = resolveAge(age);
  if (!ageOutcome.ok) return { ok: false, error: ageOutcome.error };
  const { ageDays, ageMonths, source: ageSource } = ageOutcome.age;

  if (ageDays < 0) return { ok: false, error: "Age cannot be negative." };
  const ageInScope = ageDays < AGE_DAYS_UNDER_5;
  if (!ageInScope) {
    return {
      ok: false,
      error: `Age (${Math.round(ageMonths)} months) is outside the 0-59 month scope of this module. This tool set does not cover children 5 years and older.`,
    };
  }

  const dataQualityFlags: DataQualityFlag[] = [
    ...checkPlausibility("weight_kg", weight_kg),
    ...checkPlausibility("length_or_height_cm", length_or_height_cm),
    ...checkPlausibility("muac_mm", muac_mm),
  ];

  const missingMeasurements: string[] = [];
  if (weight_kg === undefined) missingMeasurements.push("weight_kg");
  if (length_or_height_cm === undefined) missingMeasurements.push("length_or_height_cm");
  if (muac_mm === undefined) missingMeasurements.push("muac_mm");
  if (edema === undefined) missingMeasurements.push("edema");

  // ── WHO-recommended recumbent-length <-> standing-height conversion ──
  // Source: WHO Training Course on Child Growth Assessment, Module B — if
  // a child under 2 years is measured standing, add 0.7cm to estimate
  // recumbent length; if a child 2 years or older is measured lying down,
  // subtract 0.7cm to estimate standing height. Applied only when the
  // caller explicitly states how the child was measured; never assumed.
  let measurementAdjustmentApplied = false;
  let measurementAdjustmentDetail: string | null = null;
  let lengthCmForWfl: number | undefined; // recumbent-length-equivalent, for weight_for_length + height_for_age when <24mo
  let heightCmForWfh: number | undefined; // standing-height-equivalent, for weight_for_height + height_for_age when >=24mo

  if (length_or_height_cm !== undefined) {
    const expectRecumbent = ageMonths < RECUMBENT_TO_STANDING_SWITCH_MONTHS;
    if (expectRecumbent) {
      if (measurement_method === "standing_height") {
        lengthCmForWfl = length_or_height_cm + 0.7;
        measurementAdjustmentApplied = true;
        measurementAdjustmentDetail = `Child is under 24 months; measured standing (${length_or_height_cm}cm) — added 0.7cm per WHO convention to estimate recumbent length (${lengthCmForWfl}cm).`;
      } else {
        lengthCmForWfl = length_or_height_cm;
      }
    } else {
      if (measurement_method === "recumbent_length") {
        heightCmForWfh = length_or_height_cm - 0.7;
        measurementAdjustmentApplied = true;
        measurementAdjustmentDetail = `Child is 24 months or older; measured lying down (${length_or_height_cm}cm) — subtracted 0.7cm per WHO convention to estimate standing height (${heightCmForWfh}cm).`;
      } else {
        heightCmForWfh = length_or_height_cm;
      }
    }
  }
  const lengthOrHeightForHfa = lengthCmForWfl ?? heightCmForWfh;

  // ── weight_for_age ──
  let weightForAge: IndicatorOutcome = MISSING("weight_kg not provided");
  if (weight_kg !== undefined) {
    const outcome = computeWhoGrowthZScore({ standard: "weight_for_age", sex, value: weight_kg, age_days: ageDays });
    weightForAge = outcome.ok
      ? {
          available: true,
          raw_value: weight_kg,
          z_score: outcome.result.z_score,
          percentile: outcome.result.percentile,
          classification: outcome.result.classification,
          source_range: outcome.result.source_range,
        }
      : MISSING(outcome.error);
  }

  // ── height_for_age ──
  let heightForAge: IndicatorOutcome = MISSING("length_or_height_cm not provided");
  if (lengthOrHeightForHfa !== undefined) {
    const outcome = computeWhoGrowthZScore({
      standard: "height_for_age",
      sex,
      value: lengthOrHeightForHfa,
      age_days: ageDays,
    });
    heightForAge = outcome.ok
      ? {
          available: true,
          raw_value: lengthOrHeightForHfa,
          z_score: outcome.result.z_score,
          percentile: outcome.result.percentile,
          classification: outcome.result.classification,
          source_range: outcome.result.source_range,
        }
      : MISSING(outcome.error);
  }

  // ── weight_for_length (< 24mo) or weight_for_height (>= 24mo) ──
  let weightForLengthOrHeight: IndicatorOutcome & {
    standard_used: "weight_for_length" | "weight_for_height" | null;
  } = { ...MISSING("weight_kg and/or length_or_height_cm not provided"), standard_used: null };
  if (weight_kg !== undefined && lengthOrHeightForHfa !== undefined) {
    const standard = ageMonths < RECUMBENT_TO_STANDING_SWITCH_MONTHS ? "weight_for_length" : "weight_for_height";
    const outcome = computeWhoGrowthZScore({
      standard,
      sex,
      value: weight_kg,
      length_or_height_cm: lengthOrHeightForHfa,
    });
    weightForLengthOrHeight = outcome.ok
      ? {
          available: true,
          raw_value: weight_kg,
          z_score: outcome.result.z_score,
          percentile: outcome.result.percentile,
          classification: outcome.result.classification,
          source_range: outcome.result.source_range,
          standard_used: standard,
        }
      : { ...MISSING(outcome.error), standard_used: standard };
  }

  // ── bmi_for_age (0-5y) ──
  let bmiForAge: IndicatorOutcome = MISSING("weight_kg and/or length_or_height_cm not provided");
  if (weight_kg !== undefined && lengthOrHeightForHfa !== undefined) {
    const heightM = lengthOrHeightForHfa / 100;
    const bmi = weight_kg / (heightM * heightM);
    const outcome = computeWhoGrowthZScore({ standard: "bmi_for_age_0_5y", sex, value: bmi, age_days: ageDays });
    bmiForAge = outcome.ok
      ? {
          available: true,
          raw_value: Math.round(bmi * 10) / 10,
          z_score: outcome.result.z_score,
          percentile: outcome.result.percentile,
          classification: outcome.result.classification,
          source_range: outcome.result.source_range,
        }
      : MISSING(outcome.error);
  }

  // ── WHO/SMART z-score plausibility flags ──
  const zScoreChecks: Array<[string, IndicatorOutcome]> = [
    ["weight_for_age", weightForAge],
    ["height_for_age", heightForAge],
    [weightForLengthOrHeight.standard_used ?? "weight_for_length_or_height", weightForLengthOrHeight],
  ];
  for (const [key, indicator] of zScoreChecks) {
    const bounds = ZSCORE_PLAUSIBILITY[key];
    if (bounds && indicator.available && indicator.z_score !== undefined) {
      if (indicator.z_score < bounds.min || indicator.z_score > bounds.max) {
        dataQualityFlags.push({
          field: key,
          issue: "implausible_zscore",
          detail: `${key} z-score of ${indicator.z_score} is outside the WHO/SMART plausibility range (${bounds.min} to ${bounds.max}) and likely reflects a measurement or data-entry error rather than a true value. Re-measure before using this indicator.`,
        });
      }
    }
  }

  // ── NACS edema/MUAC/WHZ classification (reused, not reimplemented) ──
  let nacsClassification: Nacs059mResult | null = null;
  let nacsSkippedReason: string | null = null;
  const whzForNacs = weightForLengthOrHeight.available ? weightForLengthOrHeight.z_score : undefined;
  const muacInScopeForNacs = ageMonths >= 6; // NACS MUAC/WHZ cutoffs are documented as 6-59 months
  const effectiveMuacForNacs = muacInScopeForNacs ? muac_mm : undefined;
  const effectiveWhzForNacs = muacInScopeForNacs ? whzForNacs : undefined;
  const muacOrWhzWithheldByAge = !muacInScopeForNacs && (muac_mm !== undefined || whzForNacs !== undefined);
  const withheldByAgeNote =
    "MUAC/WHZ were not passed to the NACS classification because this child is under 6 months, and the " +
    "NACS MUAC/WHZ cutoffs are documented as applicable to 6-59 months.";
  try {
    if (edema === undefined && effectiveMuacForNacs === undefined && effectiveWhzForNacs === undefined) {
      nacsSkippedReason = muacOrWhzWithheldByAge
        ? `${withheldByAgeNote} No edema was provided either, so no NACS classification could be computed.`
        : "No edema, MUAC, or WHZ available to classify.";
    } else {
      nacsClassification = classifyChildren0to59m({ edema, muac_mm: effectiveMuacForNacs, whz: effectiveWhzForNacs });
      if (muacOrWhzWithheldByAge) {
        nacsSkippedReason = `${withheldByAgeNote} Only edema (if provided) was used.`;
      }
    }
  } catch (e) {
    nacsSkippedReason = e instanceof Error ? e.message : String(e);
  }

  return {
    ok: true,
    result: {
      age_days: Math.round(ageDays * 10) / 10,
      age_months: Math.round(ageMonths * 10) / 10,
      age_source: ageSource,
      age_in_scope: ageInScope,
      sex,
      measurements: {
        weight_kg: weight_kg ?? null,
        length_or_height_cm: length_or_height_cm ?? null,
        measurement_method_provided: measurement_method ?? null,
        muac_mm: muac_mm ?? null,
        edema: edema ?? null,
      },
      measurement_adjustment: { applied: measurementAdjustmentApplied, detail: measurementAdjustmentDetail },
      indicators: {
        weight_for_age: weightForAge,
        height_for_age: heightForAge,
        weight_for_length_or_height: weightForLengthOrHeight,
        bmi_for_age: bmiForAge,
      },
      nacs_classification: nacsClassification,
      nacs_classification_skipped_reason: nacsSkippedReason,
      data_quality_flags: dataQualityFlags,
      missing_measurements: missingMeasurements,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Screening questionnaires — STRONGkids, PNST, PYMS, STAMP
// All four are validated primarily in HOSPITALIZED pediatric populations,
// not community/health-centre screening. They are implemented here per an
// explicit product decision to include them (flagged clearly), not because
// they are the primary tool for community under-5 screening — that role is
// filled by anthropometry + NACS (edema/MUAC/WHZ) above.
// ─────────────────────────────────────────────────────────────────────────

const HOSPITAL_VALIDATION_NOTE =
  "Validated primarily in hospitalized pediatric inpatient populations. Interpret with caution in " +
  "community or health-centre screening, where anthropometry + NACS (edema/MUAC/WHZ) classification " +
  "above is the primary, WHO/NACS-grounded indicator.";

export interface StrongkidsInput {
  clinical_assessment_poor_nutritional_status: boolean;
  high_risk_disease: boolean;
  reduced_intake_or_losses: boolean;
  weight_loss_or_poor_gain: boolean;
}

export interface StrongkidsResult {
  responses: StrongkidsInput;
  component_scores: { clinical_assessment: number; high_risk_disease: number; intake_or_losses: number; weight_loss: number };
  total_score: number;
  risk_category: "low" | "medium" | "high";
  explanation: string;
  source: string;
  age_applicability: string;
  validated_context: string;
}

/**
 * STRONGkids (Screening Tool for Risk On Nutritional Status and Growth).
 * Source: Hulst JM, Zwart H, Hop WC, Joosten KFM. Dutch national survey to
 * test the STRONGkids nutritional risk screening tool in hospitalized
 * children. Clin Nutr. 2010;29(1):106-111.
 * Four items: high-risk disease (2 points), subjective clinical assessment
 * (1 point), nutritional intake/losses (1 point), weight loss/poor gain (1
 * point) — max total 5. Score 0 = low risk; 1-3 = medium risk; 4-5 = high
 * risk. Age applicability: approximately 1 month to 16-18 years
 * (hospitalized populations; published age range varies slightly by
 * source) — not validated for neonates under 1 month.
 */
export function strongkidsScreen(input: StrongkidsInput): StrongkidsResult {
  const clinical = input.clinical_assessment_poor_nutritional_status ? 1 : 0;
  const disease = input.high_risk_disease ? 2 : 0;
  const intake = input.reduced_intake_or_losses ? 1 : 0;
  const weightLoss = input.weight_loss_or_poor_gain ? 1 : 0;
  const total = clinical + disease + intake + weightLoss;

  let risk: StrongkidsResult["risk_category"];
  if (total === 0) risk = "low";
  else if (total <= 3) risk = "medium";
  else risk = "high";

  return {
    responses: input,
    component_scores: { clinical_assessment: clinical, high_risk_disease: disease, intake_or_losses: intake, weight_loss: weightLoss },
    total_score: total,
    risk_category: risk,
    explanation: `Score ${total}/5 (clinical assessment ${clinical}, high-risk disease ${disease}, intake/losses ${intake}, weight loss ${weightLoss}) -> ${risk} risk per Hulst et al. 2010 bands (0=low, 1-3=medium, 4-5=high).`,
    source: "Hulst JM, Zwart H, Hop WC, Joosten KFM. Clin Nutr. 2010;29(1):106-111.",
    age_applicability: "~1 month to 16-18 years (not validated for neonates under 1 month)",
    validated_context: HOSPITAL_VALIDATION_NOTE,
  };
}

export interface PnstInput {
  recent_weight_loss_or_failure_to_gain: boolean;
  reduced_intake_recent_weeks: boolean;
  looks_underweight: boolean;
  looks_thin: boolean;
}

export interface PnstResult {
  responses: PnstInput;
  affirmative_count: number;
  risk_category: "not_at_risk" | "at_risk";
  explanation: string;
  source: string;
  age_applicability: string;
  validated_context: string;
}

/**
 * PNST (Paediatric Nutrition Screening Tool).
 * Source: White M, Lawson K, Ramsey R, et al. Simple Nutrition Screening
 * Tool for Pediatric Inpatients. JPEN J Parenter Enteral Nutr.
 * 2016;40(3):392-398.
 * 4 yes/no questions; >=2 "yes" = at risk of malnutrition (refer for full
 * nutrition assessment). Age applicability: hospitalized children up to
 * ~16 years.
 */
export function pnstScreen(input: PnstInput): PnstResult {
  const flags = [
    input.recent_weight_loss_or_failure_to_gain,
    input.reduced_intake_recent_weeks,
    input.looks_underweight,
    input.looks_thin,
  ];
  const count = flags.filter(Boolean).length;
  const risk: PnstResult["risk_category"] = count >= 2 ? "at_risk" : "not_at_risk";

  return {
    responses: input,
    affirmative_count: count,
    risk_category: risk,
    explanation: `${count}/4 affirmative responses -> ${risk === "at_risk" ? "at risk (refer for full nutrition assessment)" : "not at risk"}, per White et al. 2016 (cutoff: 2 or more affirmative answers).`,
    source: "White M, Lawson K, Ramsey R, et al. JPEN J Parenter Enteral Nutr. 2016;40(3):392-398.",
    age_applicability: "hospitalized children, approximately up to 16 years",
    validated_context: HOSPITAL_VALIDATION_NOTE,
  };
}

export type PymsBmiBand = "gt_9th_centile" | "2nd_to_9th_centile" | "lt_2nd_centile";
export type PymsWeightLossBand = "none" | "uncertain_or_mild" | "obvious";
export type PymsIntakeBand = "no_change" | "decreased_more_than_half" | "little_or_none_last_week";
export type PymsPrognosisBand = "none_expected" | "probable_decrease" | "no_or_minimal_intake_expected";

export interface PymsInput {
  bmi_band: PymsBmiBand;
  weight_loss_band: PymsWeightLossBand;
  intake_band: PymsIntakeBand;
  prognosis_band: PymsPrognosisBand;
}

export interface PymsResult {
  responses: PymsInput;
  component_scores: { bmi: number; weight_loss: number; intake: number; prognosis: number };
  total_score: number;
  risk_category: "not_at_risk" | "at_risk_refer_for_dietetic_review";
  explanation: string;
  source: string;
  age_applicability: string;
  validated_context: string;
  scoring_note: string;
}

const PYMS_BMI_SCORES: Record<PymsBmiBand, number> = { gt_9th_centile: 0, "2nd_to_9th_centile": 1, lt_2nd_centile: 2 };
const PYMS_WEIGHT_LOSS_SCORES: Record<PymsWeightLossBand, number> = { none: 0, uncertain_or_mild: 1, obvious: 2 };
const PYMS_INTAKE_SCORES: Record<PymsIntakeBand, number> = { no_change: 0, decreased_more_than_half: 1, little_or_none_last_week: 2 };
const PYMS_PROGNOSIS_SCORES: Record<PymsPrognosisBand, number> = { none_expected: 0, probable_decrease: 1, no_or_minimal_intake_expected: 2 };

/**
 * PYMS (Paediatric Yorkhill Malnutrition Score).
 * Source: Gerasimidis K, Keane O, Macleod I, Flynn DM, Wright CM. A
 * four-stage evaluation of the Paediatric Yorkhill Malnutrition Score in a
 * tertiary paediatric hospital and a district general hospital. Br J Nutr.
 * 2010;104(5):751-756.
 * Four components (BMI centile, recent weight loss, intake in the last
 * week, predicted effect of current condition on nutrition), each scored
 * 0-2, total 0-8. The primary validation study's stated action threshold
 * is a BINARY one: a total score of 2 or more triggers referral for
 * dietetic review. Some secondary/review literature describes a 3-tier
 * low/medium/high banding, but reported band boundaries are inconsistent
 * across sources and don't cleanly fit the 0-8 range — rather than invent
 * a threshold, this tool uses the primary source's own binary cutoff.
 * Age applicability: hospitalized children approximately 1-16 years.
 */
export function pymsScreen(input: PymsInput): PymsResult {
  const bmi = PYMS_BMI_SCORES[input.bmi_band];
  const weightLoss = PYMS_WEIGHT_LOSS_SCORES[input.weight_loss_band];
  const intake = PYMS_INTAKE_SCORES[input.intake_band];
  const prognosis = PYMS_PROGNOSIS_SCORES[input.prognosis_band];
  const total = bmi + weightLoss + intake + prognosis;
  const risk: PymsResult["risk_category"] = total >= 2 ? "at_risk_refer_for_dietetic_review" : "not_at_risk";

  return {
    responses: input,
    component_scores: { bmi, weight_loss: weightLoss, intake, prognosis },
    total_score: total,
    risk_category: risk,
    explanation: `Score ${total}/8 (BMI ${bmi}, weight loss ${weightLoss}, intake ${intake}, prognosis ${prognosis}) -> ${risk === "at_risk_refer_for_dietetic_review" ? "at risk, refer for dietetic review" : "not at risk"} (cutoff: total >= 2, per Gerasimidis et al. 2010).`,
    source: "Gerasimidis K, Keane O, Macleod I, Flynn DM, Wright CM. Br J Nutr. 2010;104(5):751-756.",
    age_applicability: "hospitalized children, approximately 1-16 years",
    validated_context: HOSPITAL_VALIDATION_NOTE,
    scoring_note:
      "Uses the primary source's binary referral threshold (total >= 2) rather than a 3-tier banding, " +
      "since published 3-tier bands for this tool are inconsistent across secondary sources.",
  };
}

export type StampDiagnosisBand = "no_nutritional_implications" | "possible_nutritional_implications" | "definite_nutritional_implications";
export type StampIntakeBand = "no_change_good" | "recently_decreased_or_poor" | "none";
export type StampCentileGapBand = "0_to_1_centile_space" | "2_centile_spaces" | "3_or_more_centile_spaces_or_below_2nd_weight_centile";

export interface StampInput {
  diagnosis_band: StampDiagnosisBand;
  intake_band: StampIntakeBand;
  centile_gap_band: StampCentileGapBand;
}

export interface StampResult {
  responses: StampInput;
  component_scores: { diagnosis: number; intake: number; centile_gap: number };
  total_score: number;
  risk_category: "low" | "medium" | "high";
  explanation: string;
  source: string;
  age_applicability: string;
  validated_context: string;
}

const STAMP_DIAGNOSIS_SCORES: Record<StampDiagnosisBand, number> = { no_nutritional_implications: 0, possible_nutritional_implications: 2, definite_nutritional_implications: 3 };
const STAMP_INTAKE_SCORES: Record<StampIntakeBand, number> = { no_change_good: 0, recently_decreased_or_poor: 2, none: 3 };
const STAMP_CENTILE_GAP_SCORES: Record<StampCentileGapBand, number> = { "0_to_1_centile_space": 0, "2_centile_spaces": 1, "3_or_more_centile_spaces_or_below_2nd_weight_centile": 3 };

/**
 * STAMP (Screening Tool for the Assessment of Malnutrition in Paediatrics).
 * Source: McCarthy H, Dixon M, Crabtree I, Eaton-Evans MJ, McNulty H. The
 * development and evaluation of the Screening Tool for the Assessment of
 * Malnutrition in Paediatrics (STAMP) for use by healthcare staff. J Hum
 * Nutr Diet. 2012;25(4):311-318.
 * Three components (diagnosis, nutritional intake, weight/height centile
 * gap). Total: low risk 0-1, medium risk 2-3, high risk >=4. Age
 * applicability per the published UK paediatric form: approximately 2
 * weeks to 16 years — NOT appropriate for neonates in the first two weeks
 * of life or for children 5 years and older (out of this module's scope
 * regardless).
 */
export function stampScreen(input: StampInput): StampResult {
  const diagnosis = STAMP_DIAGNOSIS_SCORES[input.diagnosis_band];
  const intake = STAMP_INTAKE_SCORES[input.intake_band];
  const centileGap = STAMP_CENTILE_GAP_SCORES[input.centile_gap_band];
  const total = diagnosis + intake + centileGap;

  let risk: StampResult["risk_category"];
  if (total <= 1) risk = "low";
  else if (total <= 3) risk = "medium";
  else risk = "high";

  return {
    responses: input,
    component_scores: { diagnosis, intake, centile_gap: centileGap },
    total_score: total,
    risk_category: risk,
    explanation: `Score ${total}/9 (diagnosis ${diagnosis}, intake ${intake}, centile gap ${centileGap}) -> ${risk} risk per McCarthy et al. 2012 bands (0-1=low, 2-3=medium, >=4=high).`,
    source: "McCarthy H, Dixon M, Crabtree I, Eaton-Evans MJ, McNulty H. J Hum Nutr Diet. 2012;25(4):311-318.",
    age_applicability: "~2 weeks to 16 years (published paediatric form)",
    validated_context: HOSPITAL_VALIDATION_NOTE,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Integrated screen (Tool 6) — orchestration only, no new clinical logic
// beyond the referral ladder itself, which is deliberately conservative
// and generic (see TODO(malawi-protocol) notes).
// ─────────────────────────────────────────────────────────────────────────

export type MeasurementContext = "community" | "health_centre" | "nutrition_rehabilitation" | "hospital";

export interface Under5IntegratedScreenInput {
  sex: "male" | "female";
  age: AgeInput;
  weight_kg?: number;
  length_or_height_cm?: number;
  measurement_method?: MeasurementMethod;
  muac_mm?: number;
  edema?: boolean;
  measurement_context?: MeasurementContext;
  strongkids?: StrongkidsInput;
  pnst?: PnstInput;
  pyms?: PymsInput;
  stamp?: StampInput;
}

export interface ClinicalFlag {
  flag: string;
  detail: string;
}

export interface Under5IntegratedScreenResult {
  status: "success";
  child: { sex: "male" | "female"; age_days: number; age_months: number; age_source: ResolvedAge["source"] };
  measurement_context: MeasurementContext;
  measurement_quality: { data_quality_flags: DataQualityFlag[]; missing_measurements: string[]; measurement_adjustment: Under5AnthropometricResult["measurement_adjustment"] };
  anthropometry: Under5AnthropometricResult["indicators"];
  nacs_classification: Nacs059mResult | null;
  nacs_classification_skipped_reason: string | null;
  screening: {
    tools_administered: string[];
    tools_skipped: Array<{ tool: string; reason: string }>;
    strongkids: StrongkidsResult | null;
    pnst: PnstResult | null;
    pyms: PymsResult | null;
    stamp: StampResult | null;
    disagreement_noted: boolean;
  };
  risk: {
    anthropometric_malnutrition_status: string;
    screening_risk_summary: string;
  };
  clinical_flags: ClinicalFlag[];
  recommended_action: { urgency: "urgent" | "priority" | "routine"; action: string };
  referral: { pathway: string; todo_malawi_protocol: string };
  explanation: string;
  limitations: string[];
}

const STAMP_MIN_AGE_MONTHS = 0.5; // ~2 weeks, per the published STAMP paediatric form's stated age range

function questionnaireApplicability(ageMonths: number, context: MeasurementContext | undefined) {
  const contextNote =
    context && context !== "hospital"
      ? " These questionnaires were derived and validated in hospitalized populations; treat their result cautiously in this non-hospital context."
      : "";
  return {
    strongkids: ageMonths >= 1 ? { applicable: true } : { applicable: false, reason: `Age ${Math.round(ageMonths)} months is under STRONGkids' validated age range (~1 month+).${contextNote}` },
    pnst: ageMonths >= 1 ? { applicable: true } : { applicable: false, reason: `Age ${Math.round(ageMonths)} months is under PNST's validated age range (~1 month+).${contextNote}` },
    pyms: ageMonths >= 12 ? { applicable: true } : { applicable: false, reason: `Age ${Math.round(ageMonths)} months is under PYMS' validated age range (~1 year+).${contextNote}` },
    stamp: ageMonths >= STAMP_MIN_AGE_MONTHS ? { applicable: true } : { applicable: false, reason: `Age ${Math.round(ageMonths)} months is under STAMP's validated age range (~2 weeks+).${contextNote}` },
  };
}

/**
 * Integrated under-5 screening orchestration. Calls
 * assessUnder5Anthropometry() (which itself reuses computeWhoGrowthZScore
 * and classifyChildren0to59m) and, where age-applicable and the caller
 * supplied answers, the four screening questionnaires above. Combines
 * results into two SEPARATE risk axes (anthropometric malnutrition status,
 * and questionnaire-based nutrition risk) rather than collapsing them into
 * one number — the two axes measure different things and can legitimately
 * disagree; forcing them into a single composite score would hide that
 * disagreement rather than surface it.
 */
export function integratedUnder5Screen(
  input: Under5IntegratedScreenInput
): { ok: true; result: Under5IntegratedScreenResult } | { ok: false; error: string } {
  const context = input.measurement_context ?? "community";

  const anthroOutcome = assessUnder5Anthropometry({
    sex: input.sex,
    age: input.age,
    weight_kg: input.weight_kg,
    length_or_height_cm: input.length_or_height_cm,
    measurement_method: input.measurement_method,
    muac_mm: input.muac_mm,
    edema: input.edema,
  });
  if (!anthroOutcome.ok) return { ok: false, error: anthroOutcome.error };
  const anthro = anthroOutcome.result;

  const limitations: string[] = [
    "This is a screening/decision-support prototype, not a diagnostic device. All findings should be " +
      "confirmed and acted on by a qualified health worker.",
    "Referral pathway wording is generic/CMAM-aligned; it must be replaced with the current Malawi " +
      "Ministry of Health CMAM/NACS protocol (facility names, follow-up intervals, commodity guidance) " +
      "before real-world deployment — see referral.todo_malawi_protocol.",
  ];

  // ── screening questionnaires ──
  const applicability = questionnaireApplicability(anthro.age_months, context);
  const toolsAdministered: string[] = [];
  const toolsSkipped: Array<{ tool: string; reason: string }> = [];

  let strongkidsResult: StrongkidsResult | null = null;
  if (anthro.age_months < 12) {
    toolsSkipped.push({
      tool: "strongkids",
      reason:
        "Not administered: children under 12 months are screened using anthropometry + NACS (edema/MUAC/WHZ) " +
        "only in this module's design, rather than a hospital-validated questionnaire not specifically " +
        "validated for young infants in this age band.",
    });
  } else if (!applicability.strongkids.applicable) {
    toolsSkipped.push({ tool: "strongkids", reason: (applicability.strongkids as { applicable: false; reason: string }).reason });
  } else if (!input.strongkids) {
    toolsSkipped.push({ tool: "strongkids", reason: "Not administered: no responses were provided." });
  } else {
    strongkidsResult = strongkidsScreen(input.strongkids);
    toolsAdministered.push("strongkids");
  }

  let pnstResult: PnstResult | null = null;
  if (anthro.age_months < 12) {
    toolsSkipped.push({
      tool: "pnst",
      reason: "Not administered: children under 12 months are screened using anthropometry + NACS only (see strongkids note).",
    });
  } else if (!applicability.pnst.applicable) {
    toolsSkipped.push({ tool: "pnst", reason: (applicability.pnst as { applicable: false; reason: string }).reason });
  } else if (!input.pnst) {
    toolsSkipped.push({ tool: "pnst", reason: "Not administered: no responses were provided." });
  } else {
    pnstResult = pnstScreen(input.pnst);
    toolsAdministered.push("pnst");
  }

  let pymsResult: PymsResult | null = null;
  if (anthro.age_months < 12) {
    toolsSkipped.push({
      tool: "pyms",
      reason: "Not administered: children under 12 months are screened using anthropometry + NACS only (see strongkids note).",
    });
  } else if (!applicability.pyms.applicable) {
    toolsSkipped.push({ tool: "pyms", reason: (applicability.pyms as { applicable: false; reason: string }).reason });
  } else if (!input.pyms) {
    toolsSkipped.push({ tool: "pyms", reason: "Not administered: no responses were provided." });
  } else {
    pymsResult = pymsScreen(input.pyms);
    toolsAdministered.push("pyms");
  }

  let stampResult: StampResult | null = null;
  if (anthro.age_months < 12) {
    toolsSkipped.push({
      tool: "stamp",
      reason: "Not administered: children under 12 months are screened using anthropometry + NACS only (see strongkids note).",
    });
  } else if (!applicability.stamp.applicable) {
    toolsSkipped.push({ tool: "stamp", reason: (applicability.stamp as { applicable: false; reason: string }).reason });
  } else if (!input.stamp) {
    toolsSkipped.push({ tool: "stamp", reason: "Not administered: no responses were provided." });
  } else {
    stampResult = stampScreen(input.stamp);
    toolsAdministered.push("stamp");
  }

  if (anthro.age_months < 12) {
    limitations.push(
      "Screening questionnaires (STRONGkids/PNST/PYMS/STAMP) were not administered for this child (under " +
        "12 months) by design; nutrition risk for this age is based on anthropometry + NACS classification only."
    );
  }
  if (context !== "hospital" && toolsAdministered.length > 0) {
    limitations.push(
      `STRONGkids/PNST/PYMS/STAMP were derived and validated in hospitalized paediatric inpatient ` +
        `populations, not ${context.replace("_", " ")} screening — interpret their result as supportive, not primary, evidence in this context.`
    );
  }

  // ── clinical flags ──
  const flags: ClinicalFlag[] = [];
  for (const dq of anthro.data_quality_flags) {
    flags.push({ flag: `data_quality:${dq.issue}`, detail: dq.detail });
  }
  const addIndicatorFlag = (label: string, outcome: IndicatorOutcome) => {
    if (outcome.available && outcome.classification && !/^normal$/i.test(outcome.classification)) {
      flags.push({ flag: `${label}:${outcome.classification.replace(/\s+/g, "_")}`, detail: `${label} classified as "${outcome.classification}" (z=${outcome.z_score}).` });
    }
  };
  addIndicatorFlag("weight_for_age", anthro.indicators.weight_for_age);
  addIndicatorFlag("height_for_age", anthro.indicators.height_for_age);
  addIndicatorFlag("weight_for_length_or_height", anthro.indicators.weight_for_length_or_height);
  addIndicatorFlag("bmi_for_age", anthro.indicators.bmi_for_age);

  if (anthro.nacs_classification) {
    for (const ind of anthro.nacs_classification.indicators) {
      if (ind.classification !== "normal") {
        flags.push({ flag: `nacs_${ind.indicator}:${ind.classification}`, detail: `${ind.indicator} = ${ind.value} -> ${ind.classification} (${ind.cutoffApplied}).` });
      }
    }
  }
  for (const missing of anthro.missing_measurements) {
    flags.push({ flag: `missing_measurement:${missing}`, detail: `${missing} was not provided — not invented or substituted.` });
  }

  const screeningRiskFlags: string[] = [];
  if (strongkidsResult && strongkidsResult.risk_category !== "low") screeningRiskFlags.push(`strongkids:${strongkidsResult.risk_category}`);
  if (pnstResult && pnstResult.risk_category === "at_risk") screeningRiskFlags.push("pnst:at_risk");
  if (pymsResult && pymsResult.risk_category !== "not_at_risk") screeningRiskFlags.push("pyms:at_risk");
  if (stampResult && stampResult.risk_category !== "low") screeningRiskFlags.push(`stamp:${stampResult.risk_category}`);
  for (const f of screeningRiskFlags) flags.push({ flag: `screening_risk:${f}`, detail: `${f.split(":")[0]} flagged nutrition risk.` });

  // disagreement: at least one administered tool flags risk and at least one administered tool does not
  const administeredResults = [strongkidsResult, pnstResult, pymsResult, stampResult].filter(
    (r): r is NonNullable<typeof r> => r !== null
  );
  const anyRisk = (strongkidsResult && strongkidsResult.risk_category !== "low") ||
    (pnstResult && pnstResult.risk_category === "at_risk") ||
    (pymsResult && pymsResult.risk_category !== "not_at_risk") ||
    (stampResult && stampResult.risk_category !== "low");
  const anyNormal = (strongkidsResult && strongkidsResult.risk_category === "low") ||
    (pnstResult && pnstResult.risk_category === "not_at_risk") ||
    (pymsResult && pymsResult.risk_category === "not_at_risk") ||
    (stampResult && stampResult.risk_category === "low");
  const disagreement = administeredResults.length >= 2 && Boolean(anyRisk) && Boolean(anyNormal);
  if (disagreement) {
    flags.push({
      flag: "screening_tool_disagreement",
      detail: "Administered screening tools did not agree on nutrition risk — see the individual tool results rather than relying on a single summary.",
    });
    limitations.push("Screening tools disagreed on nutrition risk for this child; report all individual tool results, not a single collapsed verdict.");
  }

  // ── two-axis risk summary ──
  const anthropometricStatus = anthro.nacs_classification
    ? anthro.nacs_classification.overallAcuteMalnutritionClassification
    : "not_classified_insufficient_data";
  const screeningSummary =
    administeredResults.length === 0
      ? "not_administered"
      : anyRisk
        ? "risk_flagged_by_at_least_one_tool"
        : "no_risk_flagged";

  // ── referral / recommended action ladder (deterministic, most severe wins) ──
  // TODO(malawi-protocol): replace this generic, CMAM-aligned ladder with the
  // current Malawi Ministry of Health CMAM/NACS referral protocol (specific
  // facility types, follow-up intervals, and commodity guidance) before
  // real-world deployment. Nothing Malawi-specific is invented here.
  const edemaPresent = Boolean(input.edema);
  let urgency: Under5IntegratedScreenResult["recommended_action"]["urgency"];
  let action: string;

  if (edemaPresent || anthropometricStatus === "severe") {
    urgency = "urgent";
    action =
      "Urgent referral to a qualified health worker for assessment and management of suspected severe " +
      "acute malnutrition (SAM), per national CMAM protocol — same day if possible.";
  } else if (
    anthropometricStatus === "moderate" ||
    anthro.indicators.weight_for_length_or_height.classification === "wasted" ||
    anthro.indicators.weight_for_length_or_height.classification === "severely wasted"
  ) {
    urgency = "priority";
    action = "Refer for supplementary feeding / dietetic assessment for suspected moderate acute malnutrition (MAM).";
  } else if (anyRisk) {
    urgency = "priority";
    action =
      "Anthropometry does not currently indicate acute malnutrition, but screening indicates nutrition " +
      "risk — refer for further dietetic assessment.";
  } else if (
    (anthro.indicators.height_for_age.classification === "stunted" || anthro.indicators.height_for_age.classification === "severely stunted") ||
    (anthro.indicators.weight_for_age.classification === "underweight" || anthro.indicators.weight_for_age.classification === "severely underweight")
  ) {
    urgency = "routine";
    action =
      "No acute malnutrition identified, but growth faltering (stunting and/or underweight) was noted — " +
      "nutrition counselling and routine growth-monitoring follow-up recommended.";
  } else {
    urgency = "routine";
    action = "No malnutrition risk identified on this screening — continue routine growth monitoring per the national schedule.";
  }

  // ── explanation (deterministic, built from the structured evidence above) ──
  const explanationParts: string[] = [];
  explanationParts.push(`Child: ${anthro.age_months} months old, ${input.sex}.`);
  if (anthro.indicators.weight_for_length_or_height.available) {
    explanationParts.push(
      `${anthro.indicators.weight_for_length_or_height.standard_used} z-score = ${anthro.indicators.weight_for_length_or_height.z_score} (${anthro.indicators.weight_for_length_or_height.classification}).`
    );
  }
  if (anthro.nacs_classification) {
    for (const ind of anthro.nacs_classification.indicators) {
      explanationParts.push(`${ind.indicator} = ${ind.value} -> ${ind.classification} (${ind.cutoffApplied}).`);
    }
    explanationParts.push(`Overall NACS acute-malnutrition classification: ${anthro.nacs_classification.overallAcuteMalnutritionClassification}.`);
  } else if (anthro.nacs_classification_skipped_reason) {
    explanationParts.push(`NACS classification not computed: ${anthro.nacs_classification_skipped_reason}`);
  }
  for (const r of administeredResults) {
    explanationParts.push(r.explanation);
  }
  explanationParts.push(`Recommended action (${urgency}): ${action}`);

  return {
    ok: true,
    result: {
      status: "success",
      child: { sex: input.sex, age_days: anthro.age_days, age_months: anthro.age_months, age_source: anthro.age_source },
      measurement_context: context,
      measurement_quality: {
        data_quality_flags: anthro.data_quality_flags,
        missing_measurements: anthro.missing_measurements,
        measurement_adjustment: anthro.measurement_adjustment,
      },
      anthropometry: anthro.indicators,
      nacs_classification: anthro.nacs_classification,
      nacs_classification_skipped_reason: anthro.nacs_classification_skipped_reason,
      screening: {
        tools_administered: toolsAdministered,
        tools_skipped: toolsSkipped,
        strongkids: strongkidsResult,
        pnst: pnstResult,
        pyms: pymsResult,
        stamp: stampResult,
        disagreement_noted: disagreement,
      },
      risk: { anthropometric_malnutrition_status: anthropometricStatus, screening_risk_summary: screeningSummary },
      clinical_flags: flags,
      recommended_action: { urgency, action },
      referral: {
        pathway: action,
        todo_malawi_protocol:
          "TODO: replace with the current Malawi Ministry of Health CMAM/NACS referral protocol (specific " +
          "facility types — e.g. outpatient therapeutic program vs. inpatient stabilization centre — plus " +
          "follow-up intervals and commodity guidance). Not present in this repository, so not invented here.",
      },
      explanation: explanationParts.join(" "),
      limitations,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// MCP tool registration (Layer 2 — thin wrappers over the pure functions
// above; no clinical logic lives in this section)
// ─────────────────────────────────────────────────────────────────────────

const ageSchema = {
  age_days: z.number().nonnegative().optional(),
  age_months: z.number().nonnegative().optional(),
  age_years: z.number().nonnegative().optional(),
  date_of_birth: z.string().optional().describe("ISO date YYYY-MM-DD"),
  assessment_date: z.string().optional().describe("ISO date YYYY-MM-DD — required alongside date_of_birth"),
};

const strongkidsSchema = {
  clinical_assessment_poor_nutritional_status: z.boolean().describe("Subjective clinical judgement: reduced fat/muscle mass and/or sunken face"),
  high_risk_disease: z.boolean().describe("Presence of an underlying disease with a known high risk of malnutrition"),
  reduced_intake_or_losses: z.boolean().describe("Diarrhoea >=5/day and/or vomiting >=3/day recently, reduced intake before admission, existing dietitian-advised intervention, or intake reduced by pain"),
  weight_loss_or_poor_gain: z.boolean().describe("Weight loss or poor weight gain during the last weeks/months"),
};

const pnstSchema = {
  recent_weight_loss_or_failure_to_gain: z.boolean(),
  reduced_intake_recent_weeks: z.boolean(),
  looks_underweight: z.boolean(),
  looks_thin: z.boolean(),
};

const pymsSchema = {
  bmi_band: z.enum(["gt_9th_centile", "2nd_to_9th_centile", "lt_2nd_centile"]),
  weight_loss_band: z.enum(["none", "uncertain_or_mild", "obvious"]),
  intake_band: z.enum(["no_change", "decreased_more_than_half", "little_or_none_last_week"]),
  prognosis_band: z.enum(["none_expected", "probable_decrease", "no_or_minimal_intake_expected"]),
};

const stampSchema = {
  diagnosis_band: z.enum(["no_nutritional_implications", "possible_nutritional_implications", "definite_nutritional_implications"]),
  intake_band: z.enum(["no_change_good", "recently_decreased_or_poor", "none"]),
  centile_gap_band: z.enum(["0_to_1_centile_space", "2_centile_spaces", "3_or_more_centile_spaces_or_below_2nd_weight_centile"]),
};

export function registerUnder5MalnutritionScreeningTools(server: McpServer): void {
  // ── TOOL 1: under5_anthropometric_assessment ──
  server.registerTool(
    "under5_anthropometric_assessment",
    {
      title: "Under-5 Anthropometric Assessment",
      description:
        "Deterministic anthropometric assessment for a child 0-59 months: weight-for-age, height/length-for-age, " +
        "weight-for-length-or-height, and BMI-for-age WHO z-scores (reusing who_growth_zscore's logic), plus " +
        "NACS edema/MUAC/WHZ classification (reusing nacs_classify_children_0_59m's logic) when edema, MUAC, " +
        "and/or a computed WHZ are available. Applies the WHO 0.7cm recumbent-length/standing-height conversion " +
        "when measurement_method doesn't match the WHO-recommended method for the child's age. Never invents a " +
        "missing measurement — missing inputs are reported as unavailable, not defaulted.",
      inputSchema: {
        sex: z.enum(["male", "female"]),
        ...ageSchema,
        weight_kg: z.number().positive().optional(),
        length_or_height_cm: z.number().positive().optional(),
        measurement_method: z.enum(["recumbent_length", "standing_height"]).optional().describe("How length_or_height_cm was actually measured, if different from the WHO-recommended method for this child's age"),
        muac_mm: z.number().positive().optional(),
        edema: z.boolean().optional().describe("Bilateral pitting oedema present"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("under5_anthropometric_assessment", async (args) => {
      const outcome = assessUnder5Anthropometry({
        sex: args.sex,
        age: {
          age_days: args.age_days,
          age_months: args.age_months,
          age_years: args.age_years,
          date_of_birth: args.date_of_birth,
          assessment_date: args.assessment_date,
        },
        weight_kg: args.weight_kg,
        length_or_height_cm: args.length_or_height_cm,
        measurement_method: args.measurement_method,
        muac_mm: args.muac_mm,
        edema: args.edema,
      });
      if (!outcome.ok) {
        return { content: [{ type: "text" as const, text: outcome.error }], isError: true as const };
      }
      return ok(outcome.result, { disclaimer: MODULE_DISCLAIMER });
    })
  );

  // ── TOOL 2: strongkids_screen ──
  server.registerTool(
    "strongkids_screen",
    {
      title: "STRONGkids Nutritional Risk Screen",
      description:
        "Deterministic STRONGkids score (Hulst et al. 2010): 4 yes/no items -> total 0-5 -> low/medium/high " +
        `risk. ${HOSPITAL_VALIDATION_NOTE} Age applicability: ~1 month to 16-18 years.`,
      inputSchema: strongkidsSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("strongkids_screen", async (args) => ok(strongkidsScreen(args), { disclaimer: MODULE_DISCLAIMER }))
  );

  // ── TOOL 3: pnst_screen ──
  server.registerTool(
    "pnst_screen",
    {
      title: "PNST (Paediatric Nutrition Screening Tool)",
      description:
        "Deterministic PNST score (White et al. 2016): 4 yes/no items -> >=2 affirmative = at risk of " +
        `malnutrition. ${HOSPITAL_VALIDATION_NOTE} Age applicability: hospitalized children up to ~16 years.`,
      inputSchema: pnstSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("pnst_screen", async (args) => ok(pnstScreen(args), { disclaimer: MODULE_DISCLAIMER }))
  );

  // ── TOOL 4: pyms_screen ──
  server.registerTool(
    "pyms_screen",
    {
      title: "PYMS (Paediatric Yorkhill Malnutrition Score)",
      description:
        "Deterministic PYMS score (Gerasimidis et al. 2010): 4 components each 0-2 -> total 0-8 -> at-risk if " +
        `>=2 (the primary source's binary referral cutoff). ${HOSPITAL_VALIDATION_NOTE} Age applicability: ` +
        "hospitalized children approximately 1-16 years — do not use for children under 12 months.",
      inputSchema: pymsSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("pyms_screen", async (args) => ok(pymsScreen(args), { disclaimer: MODULE_DISCLAIMER }))
  );

  // ── TOOL 5: stamp_screen ──
  server.registerTool(
    "stamp_screen",
    {
      title: "STAMP (Screening Tool for the Assessment of Malnutrition in Paediatrics)",
      description:
        "Deterministic STAMP score (McCarthy et al. 2012): 3 components -> total 0-9 -> low (0-1) / medium " +
        `(2-3) / high (>=4) risk. ${HOSPITAL_VALIDATION_NOTE} Age applicability: ~2 weeks to 16 years.`,
      inputSchema: stampSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("stamp_screen", async (args) => ok(stampScreen(args), { disclaimer: MODULE_DISCLAIMER }))
  );

  // ── TOOL 6: under5_integrated_screen ──
  server.registerTool(
    "under5_integrated_screen",
    {
      title: "Under-5 Integrated Malnutrition Screening",
      description:
        "The primary orchestration tool for under-5 (0-59 month) malnutrition screening. Takes a child's " +
        "information ONCE and internally reuses under5_anthropometric_assessment's logic (WHO z-scores + NACS " +
        "edema/MUAC/WHZ classification) plus, where age-applicable and answers are supplied, the STRONGkids/" +
        "PNST/PYMS/STAMP questionnaires. Returns anthropometry, NACS classification, screening results on TWO " +
        "separate risk axes (anthropometric malnutrition status vs. questionnaire-based nutrition risk — these " +
        "are not collapsed into one number, since they can legitimately disagree), clinical flags, a " +
        "deterministic recommended action/referral, an evidence-traceable explanation, and limitations. " +
        "Children under 12 months are screened via anthropometry + NACS only (questionnaires are not " +
        "administered for this age band by design). The AI layer calling this tool MUST treat its output as " +
        "authoritative and MUST NOT recompute, override, or soften any classification, and MUST NOT invent " +
        "measurements the caller did not supply.",
      inputSchema: {
        sex: z.enum(["male", "female"]),
        ...ageSchema,
        weight_kg: z.number().positive().optional(),
        length_or_height_cm: z.number().positive().optional(),
        measurement_method: z.enum(["recumbent_length", "standing_height"]).optional(),
        muac_mm: z.number().positive().optional(),
        edema: z.boolean().optional(),
        measurement_context: z.enum(["community", "health_centre", "nutrition_rehabilitation", "hospital"]).optional().describe("Defaults to community"),
        strongkids: z.object(strongkidsSchema).optional().describe("Omit to skip STRONGkids (e.g. answers not collected)"),
        pnst: z.object(pnstSchema).optional().describe("Omit to skip PNST"),
        pyms: z.object(pymsSchema).optional().describe("Omit to skip PYMS"),
        stamp: z.object(stampSchema).optional().describe("Omit to skip STAMP"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("under5_integrated_screen", async (args) => {
      const outcome = integratedUnder5Screen({
        sex: args.sex,
        age: {
          age_days: args.age_days,
          age_months: args.age_months,
          age_years: args.age_years,
          date_of_birth: args.date_of_birth,
          assessment_date: args.assessment_date,
        },
        weight_kg: args.weight_kg,
        length_or_height_cm: args.length_or_height_cm,
        measurement_method: args.measurement_method,
        muac_mm: args.muac_mm,
        edema: args.edema,
        measurement_context: args.measurement_context,
        strongkids: args.strongkids,
        pnst: args.pnst,
        pyms: args.pyms,
        stamp: args.stamp,
      });
      if (!outcome.ok) {
        return { content: [{ type: "text" as const, text: outcome.error }], isError: true as const };
      }
      return ok(outcome.result, { disclaimer: MODULE_DISCLAIMER, nacs_disclaimer: NACS_DISCLAIMER });
    })
  );
}
