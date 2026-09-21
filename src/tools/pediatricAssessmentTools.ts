import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, safeTool, toolError } from "../utils/toolResult.js";
import {
  ENTERAL_FEEDS,
  PEDS_DISCLAIMER,
  formatEnteralCell,
  pickBelow,
  selectTermGrowthReference,
  type EnteralCell,
  type EnteralPhases,
} from "./pediatricTools.js";

/**
 * Paediatric assessment calculators built from the BND 415 Clinical Nutrition —
 * Paediatric Medicine Resources sheet. They turn the sheet's reference tables into
 * calculations that pediatricTools.ts (pure look-ups) does not do:
 *
 *   - pediatric_activity_stress_factor_reference  (activity + metabolic stress factors)
 *   - pediatric_growth_velocity_assessment        (measured velocity vs ASPEN reference)
 *   - pediatric_enteral_feed_plan                 (absolute mL/hr or mL/feed from the table)
 *
 * Pure calculation / table lookup — no Chakudya API calls. The pure functions are
 * exported so they can be unit tested without the MCP server.
 */

const round = (n: number, dp = 1) => Math.round(n * 10 ** dp) / 10 ** dp;

// ════════════════════════════════════════════════════════════════════════════
// 1. Activity and metabolic stress factors
// ════════════════════════════════════════════════════════════════════════════

export interface FactorRow {
  key: string;
  label: string;
  low: number;
  high: number;
  definition?: string;
}

export const PEDS_ACTIVITY_LEVELS: FactorRow[] = [
  {
    key: "confined_to_bed",
    label: "Confined to bed",
    low: 1.0,
    high: 1.1,
    definition: "Cerebral palsy, hospitalization, paralysis",
  },
  {
    key: "light",
    label: "Light activity",
    low: 1.3,
    high: 1.5,
    definition:
      "Spends several hours every day at school or sedentary, does not practise physical sports, uses motor " +
      "vehicles for transport, leisure activities need little physical effort (TV, reading, computers)",
  },
  {
    key: "moderate",
    label: "Moderate activity",
    low: 1.5,
    high: 1.85,
    definition: "In between light and vigorous activity",
  },
  {
    key: "high_or_vigorous",
    label: "High or vigorous activity",
    low: 1.8,
    high: 2.15,
    definition:
      "Walks long distances daily or cycles for transport; high energy-demanding occupation or chores for " +
      "several hours a day; and/or sport or exercise for several hours a day",
  },
];

export const PEDS_STRESS_FACTORS: FactorRow[] = [
  { key: "starvation", label: "Starvation", low: 0.7, high: 0.85 },
  { key: "surgery", label: "Surgery", low: 1.05, high: 1.5 },
  { key: "infection_sepsis", label: "Infection / Sepsis", low: 1.2, high: 1.6 },
  { key: "closed_head_injury", label: "Closed head injury", low: 1.3, high: 1.3 },
  { key: "trauma", label: "Trauma", low: 1.1, high: 1.8 },
  { key: "burn", label: "Burn", low: 1.5, high: 2.5 },
  { key: "growth_failure", label: "Growth failure", low: 1.5, high: 2.0 },
];

const factorRange = (f: FactorRow) => (f.low === f.high ? `${f.low}` : `${f.low}-${f.high}`);

export function computeTeeFromFactors(args: {
  bmr_kcal_per_day: number;
  activity?: FactorRow;
  stress?: FactorRow;
  weight_kg?: number;
}) {
  const aLow = args.activity?.low ?? 1;
  const aHigh = args.activity?.high ?? 1;
  const sLow = args.stress?.low ?? 1;
  const sHigh = args.stress?.high ?? 1;
  const low = args.bmr_kcal_per_day * aLow * sLow;
  const high = args.bmr_kcal_per_day * aHigh * sHigh;
  const mid = args.bmr_kcal_per_day * ((aLow + aHigh) / 2) * ((sLow + sHigh) / 2);
  const perKg = (kcal: number) => (args.weight_kg ? round(kcal / args.weight_kg, 1) : undefined);
  return {
    bmr_kcal_per_day: args.bmr_kcal_per_day,
    activity_factor_range: args.activity ? factorRange(args.activity) : null,
    stress_factor_range: args.stress ? factorRange(args.stress) : null,
    tee_kcal_per_day: { low: Math.round(low), mid: Math.round(mid), high: Math.round(high) },
    tee_kcal_per_kg_per_day: args.weight_kg
      ? { low: perKg(low), mid: perKg(mid), high: perKg(high) }
      : undefined,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 2. Growth velocity assessment (ASPEN Paediatric & Neonatal Nutrition Support Handbook, 3rd ed.)
// ════════════════════════════════════════════════════════════════════════════

type Ref =
  | { kind: "range"; lo: number; hi: number }
  | { kind: "point"; value: number }
  | { kind: "degenerate"; value: number };

/**
 * Reads a numeric reference out of the text used in pediatricTools.ts, e.g. "22-42 g/d",
 * "0.16 mm/d", or "0.37 mm/d (girls), 0.36 mm/d (boys)". A "range" whose two ends are equal
 * (the source sheet prints girls 3-6 months as "21-21 g/d") is returned as "degenerate" so
 * it is never used to classify a child.
 */
export function parseVelocityReference(text: string, sex?: "male" | "female"): Ref | null {
  const sexed = sex === "female" ? /(\d+(?:\.\d+)?)\s*mm\/d\s*\(girls\)/ : /(\d+(?:\.\d+)?)\s*mm\/d\s*\(boys\)/;
  if (text.includes("(girls)") || text.includes("(boys)")) {
    const m = text.match(sexed);
    return m ? { kind: "point", value: parseFloat(m[1]) } : null;
  }
  const range = text.match(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)/);
  if (range) {
    const lo = parseFloat(range[1]);
    const hi = parseFloat(range[2]);
    return lo >= hi ? { kind: "degenerate", value: lo } : { kind: "range", lo, hi };
  }
  const single = text.match(/(\d+(?:\.\d+)?)/);
  return single ? { kind: "point", value: parseFloat(single[1]) } : null;
}

function classifyAgainst(value: number, ref: Ref, referenceText: string) {
  if (ref.kind === "range") {
    const classification = value < ref.lo ? "below_reference" : value > ref.hi ? "above_reference" : "within_reference";
    return { reference: referenceText, classification };
  }
  if (ref.kind === "point") {
    return {
      reference: referenceText,
      classification: "single_reference_value",
      percent_of_reference: round((value / ref.value) * 100, 0),
      note: "The sheet gives one reference value rather than a range, so the result is shown as a percentage of it, not classified.",
    };
  }
  return {
    reference: referenceText,
    classification: null,
    note:
      `The sheet prints this reference as "${referenceText}", which is not a valid range and is probably a ` +
      "transcription error. The velocity is reported but not classified; check the ASPEN handbook.",
  };
}

// Preterm reference values, numeric form of PRETERM_GROWTH_REFERENCE in pediatricTools.ts.
const PRETERM = {
  weight_g_per_kg_per_d: { lo: 15, hi: 20 },
  length_cm_per_week_min: 1,
  hc_cm_per_week: { lo: 0.8, hi: 1 },
  max_initial_weight_loss_percent: 15,
  regain_by_day: 14,
};

export interface GrowthVelocityInput {
  population: "term" | "preterm";
  sex?: "male" | "female";
  age_months?: number;
  age_years?: number;
  interval_days?: number;
  weight_start_kg?: number;
  weight_end_kg?: number;
  length_start_cm?: number;
  length_end_cm?: number;
  head_circumference_start_cm?: number;
  head_circumference_end_cm?: number;
  birth_weight_kg?: number;
  lowest_weight_kg?: number;
  days_to_regain_birth_weight?: number;
}

export type GrowthVelocityResult =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; error: string };

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

function pair(a: number | undefined, b: number | undefined, name: string): string | null {
  if ((a === undefined) !== (b === undefined)) return `Provide both the start and end ${name}, or neither.`;
  return null;
}

export function assessGrowthVelocity(input: GrowthVelocityInput): GrowthVelocityResult {
  const {
    population, sex, age_months, age_years, interval_days,
    weight_start_kg, weight_end_kg, length_start_cm, length_end_cm,
    head_circumference_start_cm: hc0, head_circumference_end_cm: hc1,
    birth_weight_kg, lowest_weight_kg, days_to_regain_birth_weight,
  } = input;

  for (const e of [
    pair(weight_start_kg, weight_end_kg, "weight"),
    pair(length_start_cm, length_end_cm, "length/height"),
    pair(hc0, hc1, "head circumference"),
    pair(birth_weight_kg, lowest_weight_kg, "weight (birth_weight_kg and lowest_weight_kg)"),
  ]) {
    if (e) return fail(e);
  }

  const hasWeight = weight_start_kg !== undefined;
  const hasLength = length_start_cm !== undefined;
  const hasHc = hc0 !== undefined;
  const hasLoss = birth_weight_kg !== undefined;

  if ((hasWeight || hasLength || hasHc) && (interval_days === undefined || interval_days <= 0)) {
    return fail("interval_days (days between the start and end measurements, > 0) is required.");
  }
  if (!hasWeight && !hasLength && !hasHc && !hasLoss) {
    return fail("Provide at least one measurement pair (weight, length/height, head circumference) with interval_days.");
  }
  const days = interval_days ?? 0;

  // ── Preterm ────────────────────────────────────────────────────────────────
  if (population === "preterm") {
    const out: Record<string, unknown> = {
      population: "preterm",
      source: "ASPEN Paediatric and Neonatal Nutrition Support Handbook, 3rd ed. — preterm infants",
    };
    if (hasWeight) {
      const dKg = weight_end_kg! - weight_start_kg!;
      const meanKg = (weight_end_kg! + weight_start_kg!) / 2;
      const velocity = (dKg * 1000) / days / meanKg;
      out.weight = {
        velocity_g_per_kg_per_day: round(velocity, 1),
        basis: "Weight change divided by days, per kg of the average of the start and end weights.",
        ...classifyAgainst(velocity, { kind: "range", lo: PRETERM.weight_g_per_kg_per_d.lo, hi: PRETERM.weight_g_per_kg_per_d.hi }, "15-20 g/kg/d"),
      };
    }
    if (hasLength) {
      const cmPerWeek = ((length_end_cm! - length_start_cm!) / days) * 7;
      out.length = {
        velocity_cm_per_week: round(cmPerWeek, 2),
        reference: "> 1 cm/week",
        classification: cmPerWeek > PRETERM.length_cm_per_week_min ? "meets_reference" : "below_reference",
      };
    }
    if (hasHc) {
      const cmPerWeek = ((hc1! - hc0!) / days) * 7;
      out.head_circumference = {
        velocity_cm_per_week: round(cmPerWeek, 2),
        ...classifyAgainst(cmPerWeek, { kind: "range", lo: PRETERM.hc_cm_per_week.lo, hi: PRETERM.hc_cm_per_week.hi }, "0.8-1 cm/week"),
      };
    }
    if (hasLoss) {
      const lossPct = ((birth_weight_kg! - lowest_weight_kg!) / birth_weight_kg!) * 100;
      const loss: Record<string, unknown> = {
        initial_weight_loss_percent: round(lossPct, 1),
        reference: "Lose <= 15% of birth weight",
        classification: lossPct <= PRETERM.max_initial_weight_loss_percent ? "within_reference" : "above_reference",
      };
      if (days_to_regain_birth_weight !== undefined) {
        loss.regain_reference = "Regain birth weight in 10-14 days";
        loss.days_to_regain_birth_weight = days_to_regain_birth_weight;
        loss.regained_by_day_14 = days_to_regain_birth_weight <= PRETERM.regain_by_day;
      }
      out.initial_weight_loss = loss;
    }
    out.disclaimer = PEDS_DISCLAIMER;
    return { ok: true, result: out };
  }

  // ── Term ───────────────────────────────────────────────────────────────────
  if (hasHc || hasLoss || days_to_regain_birth_weight !== undefined) {
    return fail("Head circumference and initial weight loss references are only available for preterm infants (population='preterm').");
  }
  const totalMonths = age_months ?? (age_years !== undefined ? age_years * 12 : undefined);
  if (totalMonths === undefined) return fail("age_months or age_years is required for term infants/children.");

  const ref = selectTermGrowthReference(totalMonths);
  if (ref.kind === "out_of_range") return fail(ref.reason);

  let weightRefText: string;
  let linearRefText: string;
  let ageBracket: string;
  let linearKey: "length" | "height";
  if (ref.kind === "months") {
    if (!sex) return fail("sex is required for term infants up to 24 months.");
    weightRefText = sex === "male" ? ref.row.boysWeight : ref.row.girlsWeight;
    linearRefText = ref.row.length;
    ageBracket = ref.row.label;
    linearKey = "length";
  } else {
    weightRefText = ref.row.weight;
    linearRefText = ref.row.height;
    ageBracket = ref.row.label;
    linearKey = "height";
  }

  const out: Record<string, unknown> = {
    population: "term",
    source: `ASPEN Paediatric and Neonatal Nutrition Support Handbook, 3rd ed. — term ${ref.kind === "months" ? "infants" : "children"}`,
    age_bracket: ageBracket,
    interval_days: days,
  };

  if (hasWeight) {
    const velocity = ((weight_end_kg! - weight_start_kg!) * 1000) / days;
    const parsed = parseVelocityReference(weightRefText, sex);
    out.weight = {
      velocity_g_per_day: round(velocity, 1),
      ...(parsed ? classifyAgainst(velocity, parsed, weightRefText) : { reference: weightRefText, classification: null }),
    };
  }
  if (hasLength) {
    const velocity = ((length_end_cm! - length_start_cm!) * 10) / days;
    const parsed = parseVelocityReference(linearRefText, sex);
    out[linearKey] = {
      velocity_mm_per_day: round(velocity, 3),
      ...(parsed ? classifyAgainst(velocity, parsed, linearRefText) : { reference: linearRefText, classification: null }),
    };
  }
  out.note =
    "Reference velocities are averages over longer periods; a short interval or a small measurement error can move " +
    "the calculated velocity a lot, so interpret alongside the growth chart trend.";
  out.disclaimer = PEDS_DISCLAIMER;
  return { ok: true, result: out };
}

// ════════════════════════════════════════════════════════════════════════════
// 3. Enteral feed plan (Pediatric and Nutrition Support Handbook, 3rd ed., 2024)
// ════════════════════════════════════════════════════════════════════════════

const perKg = (c: EnteralCell) => c.unit.includes("/kg");

function absolute(c: EnteralCell, weightKg: number | undefined): [number, number] | null {
  if (perKg(c)) {
    if (weightKg === undefined) return null;
    return [c.min * weightKg, c.max * weightKg];
  }
  return [c.min, c.max];
}

const r1 = (n: number) => round(n, 1);

export type EnteralPlanResult = { ok: true; result: Record<string, unknown> } | { ok: false; error: string };

export function planEnteralFeeds(args: {
  feed_type: "continuous" | "bolus";
  age_years?: number;
  age_months?: number;
  weight_kg?: number;
}): EnteralPlanResult {
  const years = args.age_years ?? (args.age_months !== undefined ? args.age_months / 12 : undefined);
  if (years === undefined) return fail("age_years or age_months is required.");

  const row = pickBelow(ENTERAL_FEEDS, years, "maxYears");
  const phases: EnteralPhases = args.feed_type === "continuous" ? row.continuous : row.bolus;

  const init = absolute(phases.initiation, args.weight_kg);
  const adv = absolute(phases.advancement, args.weight_kg);
  const goal = absolute(phases.goal, args.weight_kg);
  if (!init || !adv || !goal) {
    return fail(`weight_kg is required for the ${row.label} age group because the table doses are per kg.`);
  }

  const unit = args.feed_type === "continuous" ? "mL/hr" : "mL/feed";
  const cell = (r: [number, number]) => (r[0] === r[1] ? r1(r[0]) : { low: r1(r[0]), high: r1(r[1]) });

  // Number of advancement steps after initiation: fewest = start high, step big, stop at the
  // low goal; most = start low, step small, stop at the high goal. (1e-9 guards float noise.)
  const minSteps = Math.max(0, Math.ceil((goal[0] - init[1]) / adv[1] - 1e-9));
  const maxSteps = Math.max(0, Math.ceil((goal[1] - init[0]) / adv[0] - 1e-9));

  const result: Record<string, unknown> = {
    source: "Pediatric and Nutrition Support Handbook, 3rd edition (2024)",
    age_bracket: row.label,
    feed_type: args.feed_type,
    weight_kg: args.weight_kg ?? null,
    table_row: {
      initiation: formatEnteralCell(phases.initiation),
      advancement: formatEnteralCell(phases.advancement),
      goal_volume: formatEnteralCell(phases.goal),
    },
    initiation: { [unit]: cell(init) },
    advancement_per_step: { [unit]: cell(adv) },
    goal: { [unit]: cell(goal) },
    advancement_steps_to_goal: { fewest: minSteps, most: maxSteps },
  };

  if (args.feed_type === "continuous") {
    const every = phases.advancement.everyHours;
    if (every) {
      result.advancement_interval_hours = every[0] === every[1] ? every[0] : { shortest: every[0], longest: every[1] };
      result.estimated_hours_to_goal = { fastest: minSteps * every[0], slowest: maxSteps * every[1] };
    }
    const daily: [number, number] = [goal[0] * 24, goal[1] * 24];
    result.volume_at_goal_ml_per_day = cell(daily);
    if (args.weight_kg) result.volume_at_goal_ml_per_kg_per_day = cell([daily[0] / args.weight_kg, daily[1] / args.weight_kg]);
  } else {
    if (phases.initiation.everyHours) result.initiation_interval_hours = phases.initiation.everyHours;
    const every = phases.goal.everyHours;
    if (every) {
      result.goal_feed_interval_hours = every[0] === every[1] ? every[0] : { shortest: every[0], longest: every[1] };
      const feedsPerDay: [number, number] = [24 / every[1], 24 / every[0]];
      result.feeds_per_day_at_goal = { low: r1(feedsPerDay[0]), high: r1(feedsPerDay[1]) };
      const daily: [number, number] = [goal[0] * feedsPerDay[0], goal[1] * feedsPerDay[1]];
      result.volume_at_goal_ml_per_day = cell(daily);
      if (args.weight_kg) result.volume_at_goal_ml_per_kg_per_day = cell([daily[0] / args.weight_kg, daily[1] / args.weight_kg]);
    }
    result.advancement_note = "The sheet gives the bolus advancement per feed but no interval between increases.";
  }

  result.method_note =
    "Absolute volumes are the table's per-kg doses multiplied by weight. Step counts and hours are arithmetic on the " +
    "table ranges (fewest = start high, advance by the larger step; most = start low, advance by the smaller step). " +
    "In practice advancement follows tolerance and the clinical team's protocol.";
  result.disclaimer = PEDS_DISCLAIMER;
  return { ok: true, result };
}

// ════════════════════════════════════════════════════════════════════════════
// Registration
// ════════════════════════════════════════════════════════════════════════════

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export function registerPediatricAssessmentTools(server: McpServer) {
  // ── pediatric_activity_stress_factor_reference ────────────────────────────
  server.registerTool(
    "pediatric_activity_stress_factor_reference",
    {
      title: "Pediatric Activity & Metabolic Stress Factors",
      description:
        "Paediatric activity factors (confined to bed, light, moderate, high/vigorous) and metabolic stress " +
        "factors (starvation, surgery, infection/sepsis, closed head injury, trauma, burn, growth failure) from " +
        "BND 415 Paediatric Medicine Resources, used to scale BMR to estimated TEE. With no inputs it returns both " +
        "tables. Give bmr_kcal_per_day (from pediatric_energy_requirements, Schofield or WHO) plus an " +
        "activity_level and/or metabolic_condition to get the TEE range (low/mid/high) with the factors multiplied " +
        "together. Optionally give weight_kg for kcal/kg/day.",
      inputSchema: {
        bmr_kcal_per_day: z.number().positive().optional(),
        activity_level: z.enum(["confined_to_bed", "light", "moderate", "high_or_vigorous"]).optional(),
        metabolic_condition: z
          .enum(["starvation", "surgery", "infection_sepsis", "closed_head_injury", "trauma", "burn", "growth_failure"])
          .optional(),
        weight_kg: z.number().positive().optional(),
      },
      annotations: READ_ONLY,
    },
    safeTool("pediatric_activity_stress_factor_reference", async ({ bmr_kcal_per_day, activity_level, metabolic_condition, weight_kg }) => {
      const activity = PEDS_ACTIVITY_LEVELS.find((f) => f.key === activity_level);
      const stress = PEDS_STRESS_FACTORS.find((f) => f.key === metabolic_condition);

      if (bmr_kcal_per_day === undefined && !activity && !stress) {
        return ok({
          source: "BND 415 Paediatric Medicine Resources",
          activity_factors: PEDS_ACTIVITY_LEVELS.map((f) => ({ key: f.key, level: f.label, factor: factorRange(f), definition: f.definition })),
          stress_factors: PEDS_STRESS_FACTORS.map((f) => ({ key: f.key, condition: f.label, factor: factorRange(f) })),
          usage: "Estimated TEE = BMR x activity factor x stress factor (use only the factors that apply).",
          disclaimer: PEDS_DISCLAIMER,
        });
      }
      if (bmr_kcal_per_day === undefined) {
        return ok({
          source: "BND 415 Paediatric Medicine Resources",
          activity: activity ? { level: activity.label, factor: factorRange(activity), definition: activity.definition } : null,
          stress: stress ? { condition: stress.label, factor: factorRange(stress) } : null,
          note: "Add bmr_kcal_per_day to calculate a TEE range.",
          disclaimer: PEDS_DISCLAIMER,
        });
      }
      if (!activity && !stress) {
        return toolError("Give an activity_level and/or a metabolic_condition together with bmr_kcal_per_day.");
      }
      return ok({
        source: "BND 415 Paediatric Medicine Resources",
        activity: activity ? { level: activity.label, definition: activity.definition } : null,
        stress: stress ? { condition: stress.label } : null,
        ...computeTeeFromFactors({ bmr_kcal_per_day, activity, stress, weight_kg }),
        note: "Factors are multiplied together, as in pediatric_energy_requirements. Low uses the lowest factors, high the highest.",
        disclaimer: PEDS_DISCLAIMER,
      });
    })
  );

  // ── pediatric_growth_velocity_assessment ──────────────────────────────────
  server.registerTool(
    "pediatric_growth_velocity_assessment",
    {
      title: "Pediatric Growth Velocity Assessment",
      description:
        "Calculate a child's actual growth velocity from two measurements and compare it with the ASPEN Paediatric " +
        "and Neonatal Nutrition Support Handbook (3rd ed.) reference. TERM (population='term'): weight in g/day and " +
        "length/height in mm/day; age_months or age_years is required (sex too, up to 24 months); references cover " +
        "0-24 months and 2 to <11 years. PRETERM (population='preterm'): weight in g/kg/day (vs 15-20), length in " +
        "cm/week (vs > 1), head circumference in cm/week (vs 0.8-1), and initial weight loss (vs <= 15%, regain by " +
        "10-14 days). Every measurement is a start/end pair over interval_days. Use pediatric_growth_velocity to " +
        "just look up the reference values.",
      inputSchema: {
        population: z.enum(["term", "preterm"]),
        sex: z.enum(["male", "female"]).optional(),
        age_months: z.number().nonnegative().optional(),
        age_years: z.number().nonnegative().optional(),
        interval_days: z.number().positive().optional().describe("Days between the start and end measurements"),
        weight_start_kg: z.number().positive().optional(),
        weight_end_kg: z.number().positive().optional(),
        length_start_cm: z.number().positive().optional().describe("Length (infants) or height (children)"),
        length_end_cm: z.number().positive().optional(),
        head_circumference_start_cm: z.number().positive().optional().describe("Preterm only"),
        head_circumference_end_cm: z.number().positive().optional(),
        birth_weight_kg: z.number().positive().optional().describe("Preterm only, for initial weight loss"),
        lowest_weight_kg: z.number().positive().optional().describe("Preterm only: lowest weight after birth"),
        days_to_regain_birth_weight: z.number().nonnegative().optional().describe("Preterm only"),
      },
      annotations: READ_ONLY,
    },
    safeTool("pediatric_growth_velocity_assessment", async (args) => {
      const r = assessGrowthVelocity(args);
      return r.ok ? ok(r.result) : toolError(r.error);
    })
  );

  // ── pediatric_enteral_feed_plan ───────────────────────────────────────────
  server.registerTool(
    "pediatric_enteral_feed_plan",
    {
      title: "Pediatric Enteral Feed Plan (Absolute Volumes)",
      description:
        "Turn the Pediatric and Nutrition Support Handbook (3rd ed., 2024) enteral feed table into actual volumes " +
        "for a child: initiation, advancement per step and goal as mL/hr (continuous) or mL/feed (bolus), the " +
        "number of advancement steps to goal, estimated hours to goal (continuous), and the daily volume at goal. " +
        "Needs age and feed_type; weight_kg is required under 7 years (the table doses are per kg). Use " +
        "pediatric_enteral_feed_advancement to see the raw table text.",
      inputSchema: {
        feed_type: z.enum(["continuous", "bolus"]),
        age_years: z.number().nonnegative().optional(),
        age_months: z.number().nonnegative().optional(),
        weight_kg: z.number().positive().optional(),
      },
      annotations: READ_ONLY,
    },
    safeTool("pediatric_enteral_feed_plan", async (args) => {
      const r = planEnteralFeeds(args);
      return r.ok ? ok(r.result) : toolError(r.error);
    })
  );
}
