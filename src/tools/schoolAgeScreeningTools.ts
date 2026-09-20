import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, safeTool } from "../utils/toolResult.js";
import { computeWhoGrowthZScore } from "./whoGrowthTools.js";
import {
  classifyChildren5to17y,
  worstAcuteClassification,
  NACS_DISCLAIMER,
  type IndicatorResult,
  type Nacs517yResult,
  type Severity,
} from "./nacsClassificationTools.js";
import {
  resolveAge,
  ageSchema,
  strongkidsSchema,
  strongkidsScreen,
  type AgeInput,
  type ResolvedAge,
  type DataQualityFlag,
  type ClinicalFlag,
  type MeasurementContext,
  type StrongkidsInput,
  type StrongkidsResult,
} from "./under5MalnutritionScreeningTools.js";
import {
  fetchBmiForAge,
  bmiForAgeSeverity,
  bmiForAgeStatusFromWhoLabel,
  BMI_FOR_AGE_MIN_MONTHS,
  BMI_FOR_AGE_MAX_MONTHS,
  type BmiForAgeFetcher,
  type BmiForAgeStatus,
} from "./bmiForAgeTools.js";

/**
 * School-age children and adolescents (5 to <18 years) malnutrition
 * screening workflow.
 *
 * Extends the under-5 and pregnant/postpartum modules to the next population.
 * Like those, this is an ORCHESTRATION layer over engines that already exist
 * in this repository — it does not reimplement them:
 *   - Edema + age-banded MUAC classification: classifyChildren5to17y() from
 *     nacsClassificationTools.ts (NACS User's Guide Module 2).
 *   - BMI-for-age: the Chakudya API's /bmi-for-age/classify endpoint (WHO
 *     2007 table as printed in Malawi MoH "Eat Well to Live Well" 2021,
 *     Annex 2) via fetchBmiForAge() in bmiForAgeTools.ts is the PRIMARY
 *     classifier. The in-process WHO 2007 LMS calculator
 *     (computeWhoGrowthZScore, standard bmi_for_age_5_19y) always supplies
 *     the z-score/percentile, and is the FALLBACK classifier if the API call
 *     fails, so a network problem never blocks a screening. If both are
 *     available and disagree (possible within rounding of the table's
 *     1-decimal cut-offs), the API result is used and the disagreement is
 *     flagged rather than hidden.
 *
 * Same three-layer architecture as the other screening modules:
 *   Layer 1: deterministic calculation/classification/referral ladder (here
 *            and in the reused modules). No LLM involvement.
 *   Layer 2: the MCP tool registered at the bottom of this file.
 *   Layer 3 (NOT here): a conversational agent (e.g. schoolAgeScreening.js in
 *            thanzi-coach-whatsapp) that asks the questions and narrates the
 *            result. It must treat classifications and recommended_action as
 *            authoritative — never recompute, override, or soften them, and
 *            never invent measurements the health worker did not provide.
 *
 * Scope: 60 <= age < 216 months. NACS groups 18+ as adults, so 18-19 year
 * olds go to adult_integrated_screen. BMI-for-age needs 61-228 completed
 * months; a child measured between exactly 60 and 61 months still gets
 * edema/MUAC classification, but BMI-for-age is reported unavailable.
 *
 * NOT covered (no reference loaded — nothing is invented): height-for-age
 * (stunting) and weight-for-age for 5-19 years. Only BMI-for-age exists for
 * this age range in this repository.
 *
 * MALAWI / DEPLOYMENT NOTE: same caveat as the under-5 module — referral
 * wording is generic/CMAM-aligned, NOT the specific Malawi Ministry of Health
 * protocol. See TODO(malawi-protocol) in the tool output.
 *
 * Screening/decision-support prototype only — not a diagnostic device.
 */

const MODULE_DISCLAIMER =
  "Screening/decision-support tool only. Classifications are produced by deterministic rules: BMI-for-age " +
  "from the WHO 2007 reference (Malawi MoH 'Eat Well to Live Well' 2021, Annex 2, via the Chakudya API; " +
  "in-process WHO 2007 LMS fallback), and edema/age-banded MUAC from the NACS User's Guide. This is not a " +
  "diagnosis and not a substitute for assessment and management by a qualified health worker. Referral " +
  "wording is generic/CMAM-aligned, not the specific Malawi Ministry of Health protocol — see the " +
  "todo_malawi_protocol field.";

const MIN_MONTHS = 60; // matches the end of the under-5 module's window
const MAX_MONTHS_EXCLUSIVE = 216; // 18 years — NACS adult group starts here

/** Gross data-entry sanity bounds only (unit/typo catching), NOT clinical thresholds. */
const PLAUSIBILITY_BOUNDS = {
  weight_kg: { min: 5, max: 200 },
  height_cm: { min: 60, max: 220 },
  muac_mm: { min: 80, max: 450 },
  bmi: { min: 5, max: 60 },
} as const;

/** WHO AnthroPlus flagging convention for BMI-for-age z-scores: outside -5/+5 is likely a measurement or entry error. */
const BAZ_PLAUSIBILITY = { min: -5, max: 5 };

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

export type BmiForAgeSource = "chakudya_api_bmi_for_age" | "local_who2007_lms";

export interface SchoolAgeBmiForAge {
  available: boolean;
  reason_unavailable?: string;
  bmi?: number;
  status?: BmiForAgeStatus;
  severity?: Severity;
  z_score?: number;
  percentile?: number;
  /** Which engine produced `status`. */
  source?: BmiForAgeSource;
  reference?: string;
  cutoffs?: Record<string, number>;
  /** true/false when both engines produced a status; null when only one did. */
  sources_agree?: boolean | null;
  api_error?: string;
}

export interface SchoolAgeIntegratedScreenInput {
  sex: "male" | "female";
  age: AgeInput;
  weight_kg?: number;
  height_cm?: number;
  /** Alternative to weight_kg + height_cm. Ignored (and flagged) if both weight and height are given. */
  bmi?: number;
  muac_mm?: number;
  edema?: boolean;
  /** Set true for a pregnant/postpartum adolescent — BMI-for-age does not apply; use pregnant_postpartum_integrated_screen. */
  pregnant_or_postpartum?: boolean;
  measurement_context?: MeasurementContext;
  strongkids?: StrongkidsInput;
}

export interface SchoolAgeIntegratedScreenResult {
  status: "success";
  child: { sex: "male" | "female"; age_days: number; age_months: number; age_years: number; age_source: ResolvedAge["source"] };
  measurement_context: MeasurementContext;
  measurement_quality: { data_quality_flags: DataQualityFlag[]; missing_measurements: string[] };
  anthropometry: { bmi_for_age: SchoolAgeBmiForAge };
  nacs_classification: {
    ageGroup: string;
    indicators: IndicatorResult[];
    overallMalnutritionClassification: Severity;
    note: string;
  } | null;
  nacs_classification_skipped_reason: string | null;
  screening: {
    tools_administered: string[];
    tools_skipped: Array<{ tool: string; reason: string }>;
    strongkids: StrongkidsResult | null;
  };
  risk: { anthropometric_malnutrition_status: string; screening_risk_summary: string };
  clinical_flags: ClinicalFlag[];
  recommended_action: { urgency: "urgent" | "priority" | "routine"; action: string };
  referral: { pathway: string; todo_malawi_protocol: string };
  explanation: string;
  limitations: string[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Classifies BMI-for-age using the API as primary and the in-process WHO
 * 2007 LMS as z-score provider + fallback. Exported for unit tests.
 */
export async function assessBmiForAge(
  args: {
    sex: "male" | "female";
    ageMonths: number;
    ageDays: number;
    bmi: number;
    weight_kg?: number;
    height_cm?: number;
  },
  fetcher: BmiForAgeFetcher = fetchBmiForAge
): Promise<SchoolAgeBmiForAge> {
  const { sex, ageMonths, ageDays, bmi, weight_kg, height_cm } = args;
  const completedMonths = Math.floor(ageMonths);

  if (!Number.isFinite(bmi) || bmi <= 0) {
    return { available: false, reason_unavailable: "BMI is not a positive number." };
  }
  if (completedMonths < BMI_FOR_AGE_MIN_MONTHS || completedMonths > BMI_FOR_AGE_MAX_MONTHS) {
    return {
      available: false,
      reason_unavailable:
        `BMI-for-age reference covers ${BMI_FOR_AGE_MIN_MONTHS}-${BMI_FOR_AGE_MAX_MONTHS} completed months ` +
        `(5y 1m to 19y 0m); this child is ${completedMonths} completed months. Edema/MUAC classification still applies.`,
    };
  }

  // Local WHO 2007 LMS: z-score + percentile (and fallback status).
  const local = computeWhoGrowthZScore({ standard: "bmi_for_age_5_19y", sex, value: bmi, age_days: ageDays });
  const localZ = local.ok ? local.result.z_score : undefined;
  // Classify from the calculator's own label (built from the UNROUNDED z-score), not from the rounded z shown to users.
  const localStatus = local.ok ? bmiForAgeStatusFromWhoLabel(local.result.classification) : undefined;

  // Chakudya API: primary classifier.
  let apiStatus: BmiForAgeStatus | undefined;
  let apiCutoffs: Record<string, number> | undefined;
  let apiSource: string | undefined;
  let apiError: string | undefined;
  try {
    const data = await fetcher({ sex, age_months: completedMonths, bmi, weight_kg, height_cm });
    apiStatus = data.status;
    apiCutoffs = data.cutoffs;
    apiSource = data.source;
  } catch (e) {
    apiError = e instanceof Error ? e.message : String(e);
  }

  if (apiStatus === undefined && localStatus === undefined) {
    return {
      available: false,
      reason_unavailable:
        `BMI-for-age could not be classified: API error (${apiError ?? "unknown"}) and local WHO 2007 calculation ` +
        `${local.ok ? "returned nothing" : `failed (${local.error})`}.`,
      api_error: apiError,
    };
  }

  const status = (apiStatus ?? localStatus) as BmiForAgeStatus;
  const usedApi = apiStatus !== undefined;

  return {
    available: true,
    bmi: round1(bmi),
    status,
    severity: bmiForAgeSeverity(status),
    z_score: localZ,
    percentile: local.ok ? local.result.percentile : undefined,
    source: usedApi ? "chakudya_api_bmi_for_age" : "local_who2007_lms",
    reference: usedApi
      ? (apiSource ?? "WHO 2007 BMI-for-age, Malawi MoH Eat Well to Live Well (2021), Annex 2")
      : "WHO Reference 2007 BMI-for-age (in-process LMS calculation; Chakudya API unavailable)",
    cutoffs: apiCutoffs,
    sources_agree: apiStatus !== undefined && localStatus !== undefined ? apiStatus === localStatus : null,
    api_error: apiError,
  };
}

export async function integratedSchoolAgeScreen(
  input: SchoolAgeIntegratedScreenInput,
  deps: { fetchBmiForAge?: BmiForAgeFetcher } = {}
): Promise<{ ok: true; result: SchoolAgeIntegratedScreenResult } | { ok: false; error: string }> {
  const context = input.measurement_context ?? "community";

  if (input.pregnant_or_postpartum) {
    return {
      ok: false,
      error:
        "BMI-for-age does not apply to a pregnant or postpartum adolescent. Use pregnant_postpartum_integrated_screen instead.",
    };
  }

  const ageOutcome = resolveAge(input.age);
  if (!ageOutcome.ok) return { ok: false, error: ageOutcome.error };
  const { ageDays, ageMonths, source: ageSource } = ageOutcome.age;

  if (ageMonths < MIN_MONTHS) {
    return {
      ok: false,
      error: `Age (${Math.round(ageMonths)} months) is below the 5-year lower bound of this module. Use under5_integrated_screen for children 0-59 months.`,
    };
  }
  if (ageMonths >= MAX_MONTHS_EXCLUSIVE) {
    return {
      ok: false,
      error: `Age (${Math.round((ageMonths / 12) * 10) / 10} years) is outside the 5-17 year scope of this module (NACS classifies 18+ as adults). Use adult_integrated_screen.`,
    };
  }
  const ageYears = ageMonths / 12;

  // ── BMI: weight + height take precedence over a pre-computed BMI ──
  const { weight_kg, height_cm, muac_mm, edema } = input;
  const flags: DataQualityFlag[] = [
    ...checkPlausibility("weight_kg", weight_kg),
    ...checkPlausibility("height_cm", height_cm),
    ...checkPlausibility("muac_mm", muac_mm),
  ];

  let bmi: number | undefined;
  const hasWeightHeight = weight_kg !== undefined && height_cm !== undefined;
  if (hasWeightHeight) {
    const m = height_cm / 100;
    bmi = weight_kg / (m * m); // unrounded on purpose: rounding first can flip a borderline result
    if (input.bmi !== undefined) {
      flags.push({
        field: "bmi",
        issue: "ignored",
        detail: "bmi was ignored because weight_kg and height_cm were both provided; BMI was calculated from those instead.",
      });
    }
  } else if (input.bmi !== undefined) {
    bmi = input.bmi;
  }
  if (bmi !== undefined) flags.push(...checkPlausibility("bmi", bmi));

  const missing: string[] = [];
  if (bmi === undefined) missing.push(weight_kg === undefined && height_cm === undefined ? "weight_kg + height_cm (or bmi)" : weight_kg === undefined ? "weight_kg" : "height_cm");
  if (muac_mm === undefined) missing.push("muac_mm");
  if (edema === undefined) missing.push("edema");

  // ── BMI-for-age (API primary, local LMS fallback/z-score) ──
  let bmiForAge: SchoolAgeBmiForAge = {
    available: false,
    reason_unavailable: "weight_kg + height_cm (or bmi) not provided",
  };
  if (bmi !== undefined && !(bmi > 0 && Number.isFinite(bmi))) {
    return { ok: false, error: "BMI is not a positive number — check weight_kg / height_cm / bmi." };
  }
  if (bmi !== undefined) {
    bmiForAge = await assessBmiForAge(
      { sex: input.sex, ageMonths, ageDays, bmi, weight_kg: hasWeightHeight ? weight_kg : undefined, height_cm: hasWeightHeight ? height_cm : undefined },
      deps.fetchBmiForAge ?? fetchBmiForAge
    );
  }

  if (bmiForAge.available && bmiForAge.z_score !== undefined && (bmiForAge.z_score < BAZ_PLAUSIBILITY.min || bmiForAge.z_score > BAZ_PLAUSIBILITY.max)) {
    flags.push({
      field: "bmi_for_age",
      issue: "implausible_z_score",
      detail: `BMI-for-age z-score ${bmiForAge.z_score} is outside the WHO plausibility range (${BAZ_PLAUSIBILITY.min} to +${BAZ_PLAUSIBILITY.max}); re-measure and check units before acting on it.`,
    });
  }

  // ── NACS edema + MUAC (reused engine), then BMI-for-age indicator appended ──
  let nacs: Nacs517yResult | null = null;
  let nacsSkipped: string | null = null;
  const nacsIndicators: IndicatorResult[] = [];
  if (edema !== undefined || muac_mm !== undefined) {
    nacs = classifyChildren5to17y({ age_years: ageYears, edema, muac_mm });
    nacsIndicators.push(...nacs.indicators);
  }
  if (bmiForAge.available && bmiForAge.status && bmiForAge.severity) {
    nacsIndicators.push({
      indicator: "bmi_for_age",
      value: `${bmiForAge.bmi} kg/m2${bmiForAge.z_score !== undefined ? ` (z=${bmiForAge.z_score})` : ""} -> ${bmiForAge.status}`,
      classification: bmiForAge.severity,
      cutoffApplied:
        "severe thinness < -3SD (severe), thinness < -2SD (moderate), normal -2SD to +1SD, overweight > +1SD, obesity > +2SD " +
        `[${bmiForAge.source === "chakudya_api_bmi_for_age" ? "Chakudya API /bmi-for-age/classify" : "local WHO 2007 LMS fallback"}]`,
    });
  }
  const nacsClassification: SchoolAgeIntegratedScreenResult["nacs_classification"] =
    nacsIndicators.length > 0
      ? {
          ageGroup: "5-17 years",
          indicators: nacsIndicators,
          overallMalnutritionClassification: worstAcuteClassification(nacsIndicators),
          note:
            nacs?.note ??
            "Weight loss >5% since last visit is not a listed classification criterion for this age group in the source guide.",
        }
      : null;
  if (!nacsClassification) {
    nacsSkipped = "No classifiable measurement was provided (need MUAC, oedema present, or weight + height / BMI).";
  }

  // ── optional STRONGkids ──
  const toolsAdministered: string[] = [];
  const toolsSkipped: Array<{ tool: string; reason: string }> = [];
  let strongkids: StrongkidsResult | null = null;
  if (input.strongkids) {
    strongkids = strongkidsScreen(input.strongkids);
    toolsAdministered.push("strongkids");
  } else {
    toolsSkipped.push({ tool: "strongkids", reason: "Not administered: no responses were provided." });
  }
  toolsSkipped.push({
    tool: "pnst/pyms/stamp",
    reason: "Not part of this integrated screen; call pnst_screen, pyms_screen or stamp_screen directly if needed (validated up to ~16 years, hospital inpatients).",
  });

  const limitations: string[] = [
    "This is a screening/decision-support prototype, not a diagnostic device. All findings should be confirmed and acted on by a qualified health worker.",
    "Referral pathway wording is generic/CMAM-aligned; it must be replaced with the current Malawi Ministry of Health protocol (facility names, follow-up intervals, commodity guidance) before real-world deployment — see referral.todo_malawi_protocol.",
    "Height-for-age (stunting) and weight-for-age are not computed for 5-19 years: no WHO 2007 reference for those indicators is loaded in this server. Only BMI-for-age, MUAC and oedema are assessed.",
    "A single measurement is not a substitute for growth trajectory over time.",
  ];
  if (bmiForAge.available && bmiForAge.source === "local_who2007_lms") {
    limitations.push(
      `BMI-for-age was classified by the in-process WHO 2007 calculation because the Chakudya API call failed (${bmiForAge.api_error ?? "unknown error"}).`
    );
  }
  if (bmiForAge.available && bmiForAge.sources_agree === false) {
    limitations.push(
      "The Chakudya API table and the in-process WHO 2007 calculation gave different BMI-for-age categories (a borderline value — the table's cut-offs are printed to 1 decimal). The API category was used; consider re-measuring."
    );
  }
  if (!bmiForAge.available && ageMonths >= MIN_MONTHS && ageMonths < BMI_FOR_AGE_MIN_MONTHS) {
    limitations.push("BMI-for-age reference starts at 5y 1m (61 months); re-screen BMI-for-age after that age.");
  }
  if (strongkids && context !== "hospital") {
    limitations.push(
      `STRONGkids was derived and validated in hospitalized paediatric inpatients, not ${context.replace("_", " ")} screening — interpret its result as supportive, not primary, evidence in this context.`
    );
  }

  // ── clinical flags ──
  const clinicalFlags: ClinicalFlag[] = [];
  for (const dq of flags) clinicalFlags.push({ flag: `data_quality:${dq.issue}`, detail: dq.detail });
  if (nacsClassification) {
    for (const ind of nacsClassification.indicators) {
      if (ind.classification !== "normal") {
        clinicalFlags.push({ flag: `nacs_${ind.indicator}:${ind.classification}`, detail: `${ind.indicator} = ${ind.value} -> ${ind.classification} (${ind.cutoffApplied}).` });
      }
    }
  }
  if (bmiForAge.available && bmiForAge.sources_agree === false) {
    clinicalFlags.push({ flag: "bmi_for_age_source_disagreement", detail: "Chakudya API table and local WHO 2007 calculation gave different BMI-for-age categories; API category used." });
  }
  for (const m of missing) clinicalFlags.push({ flag: `missing_measurement:${m}`, detail: `${m} was not provided — not invented or substituted.` });
  const strongkidsRisk = strongkids !== null && strongkids.risk_category !== "low";
  if (strongkidsRisk && strongkids) clinicalFlags.push({ flag: `screening_risk:strongkids:${strongkids.risk_category}`, detail: "strongkids flagged nutrition risk." });

  // ── risk axes + action ladder (deterministic; most severe wins) ──
  // TODO(malawi-protocol): replace this generic, CMAM-aligned ladder with the
  // current Malawi Ministry of Health referral protocol for school-age
  // children/adolescents (facility types, follow-up intervals, commodities).
  const anthropometricStatus = nacsClassification ? nacsClassification.overallMalnutritionClassification : "not_classified_insufficient_data";
  const hasOverweight = nacsClassification?.indicators.some((i) => i.classification === "overweight" || i.classification === "obesity") ?? false;
  const edemaPresent = Boolean(edema);

  let urgency: SchoolAgeIntegratedScreenResult["recommended_action"]["urgency"];
  let action: string;
  if (edemaPresent || anthropometricStatus === "severe") {
    urgency = "urgent";
    action =
      "Urgent referral to a qualified health worker for assessment and management of suspected severe acute malnutrition (SAM), per national protocol — same day if possible.";
  } else if (anthropometricStatus === "moderate") {
    urgency = "priority";
    action = "Refer for nutrition assessment and supplementary feeding / nutrition counselling for suspected moderate acute malnutrition.";
  } else if (strongkidsRisk) {
    urgency = "priority";
    action = "Anthropometry does not currently indicate acute malnutrition, but screening indicates nutrition risk — refer for further dietetic assessment.";
  } else if (anthropometricStatus === "not_classified_insufficient_data") {
    urgency = "routine";
    action = "Not enough measurements to classify nutritional status. Measure MUAC, check for bilateral pitting oedema, and record weight and height, then screen again.";
  } else if (hasOverweight) {
    urgency = "routine";
    action = "No acute malnutrition identified, but BMI-for-age is above the normal range (overweight/obesity) — nutrition and physical-activity counselling and routine growth monitoring.";
  } else {
    urgency = "routine";
    action = "No acute malnutrition identified on this screening — continue routine growth monitoring and school/community nutrition follow-up.";
  }

  const screeningSummary = strongkids === null ? "not_administered" : strongkidsRisk ? "risk_flagged_by_at_least_one_tool" : "no_risk_flagged";

  const parts: string[] = [`Child: ${round1(ageYears)} years (${Math.floor(ageMonths)} completed months), ${input.sex}.`];
  if (bmiForAge.available) {
    parts.push(`BMI-for-age: ${bmiForAge.bmi} kg/m2${bmiForAge.z_score !== undefined ? `, z=${bmiForAge.z_score}` : ""} -> ${bmiForAge.status} (${bmiForAge.source === "chakudya_api_bmi_for_age" ? "Chakudya API" : "local WHO 2007 fallback"}).`);
  } else if (bmiForAge.reason_unavailable) {
    parts.push(`BMI-for-age not computed: ${bmiForAge.reason_unavailable}`);
  }
  if (nacsClassification) {
    for (const ind of nacsClassification.indicators) {
      if (ind.indicator !== "bmi_for_age") parts.push(`${ind.indicator} = ${ind.value} -> ${ind.classification} (${ind.cutoffApplied}).`);
    }
    parts.push(`Overall NACS acute-malnutrition classification: ${nacsClassification.overallMalnutritionClassification}.`);
  } else if (nacsSkipped) {
    parts.push(`NACS classification not computed: ${nacsSkipped}`);
  }
  if (strongkids) parts.push(strongkids.explanation);
  parts.push(`Recommended action (${urgency}): ${action}`);

  return {
    ok: true,
    result: {
      status: "success",
      child: { sex: input.sex, age_days: Math.round(ageDays * 10) / 10, age_months: round1(ageMonths), age_years: round1(ageYears), age_source: ageSource },
      measurement_context: context,
      measurement_quality: { data_quality_flags: flags, missing_measurements: missing },
      anthropometry: { bmi_for_age: bmiForAge },
      nacs_classification: nacsClassification,
      nacs_classification_skipped_reason: nacsSkipped,
      screening: { tools_administered: toolsAdministered, tools_skipped: toolsSkipped, strongkids },
      risk: { anthropometric_malnutrition_status: anthropometricStatus, screening_risk_summary: screeningSummary },
      clinical_flags: clinicalFlags,
      recommended_action: { urgency, action },
      referral: {
        pathway: action,
        todo_malawi_protocol:
          "TODO: replace with the current Malawi Ministry of Health referral protocol for school-age children and adolescents (specific facility types, follow-up intervals, commodity guidance). Not present in this repository, so not invented here.",
      },
      explanation: parts.join(" "),
      limitations,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// MCP tool registration (Layer 2 — thin wrapper, no clinical logic here)
// ─────────────────────────────────────────────────────────────────────────

export function registerSchoolAgeScreeningTools(server: McpServer): void {
  server.registerTool(
    "school_age_integrated_screen",
    {
      title: "School-Age Children & Adolescents (5-17y) Integrated Malnutrition Screening",
      description:
        "Orchestration tool for malnutrition screening of school-age children and adolescents 5 to under 18 years " +
        "(for 0-59 months use under5_integrated_screen; for 18+ use adult_integrated_screen; for pregnant/postpartum " +
        "girls and women use pregnant_postpartum_integrated_screen). Takes the child's details ONCE and combines: " +
        "BMI-for-age (WHO 2007 table via the Chakudya API /bmi-for-age/classify, with an in-process WHO 2007 " +
        "fallback and z-score/percentile), NACS bilateral-oedema and age-banded MUAC classification, and an optional " +
        "STRONGkids risk questionnaire. Returns per-indicator classifications (including overweight/obesity), an " +
        "overall NACS status, clinical flags, a deterministic recommended action/referral, an evidence-traceable " +
        "explanation and limitations. Provide age via age_years, age_months, age_days, or date_of_birth + " +
        "assessment_date; provide weight_kg + height_cm (preferred) or bmi. Height-for-age/weight-for-age are not " +
        "assessed for this age range. The AI layer calling this tool MUST treat its output as authoritative and MUST " +
        "NOT recompute, override, or soften any classification, and MUST NOT invent measurements the caller did not supply.",
      inputSchema: {
        sex: z.enum(["male", "female"]),
        ...ageSchema,
        weight_kg: z.number().positive().optional(),
        height_cm: z.number().positive().optional().describe("Standing height in cm"),
        bmi: z.number().positive().optional().describe("Only if weight_kg and height_cm are not available"),
        muac_mm: z.number().positive().optional(),
        edema: z.boolean().optional().describe("Bilateral pitting oedema present"),
        pregnant_or_postpartum: z.boolean().optional().describe("If true the tool declines and points to pregnant_postpartum_integrated_screen"),
        measurement_context: z
          .enum(["community", "health_centre", "nutrition_rehabilitation", "hospital"])
          .optional()
          .describe("Defaults to community"),
        strongkids: z.object(strongkidsSchema).optional().describe("Omit to skip STRONGkids"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safeTool("school_age_integrated_screen", async (args) => {
      const outcome = await integratedSchoolAgeScreen({
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
        pregnant_or_postpartum: args.pregnant_or_postpartum,
        measurement_context: args.measurement_context,
        strongkids: args.strongkids,
      });
      if (!outcome.ok) {
        return { content: [{ type: "text" as const, text: outcome.error }], isError: true as const };
      }
      return ok(outcome.result, { disclaimer: MODULE_DISCLAIMER, nacs_disclaimer: NACS_DISCLAIMER });
    })
  );
}
