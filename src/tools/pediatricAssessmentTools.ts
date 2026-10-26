import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { chakudyaClient } from "../clients/chakudyaClient.js";
import { safeTool, toolError } from "../utils/toolResult.js";
import { okWithApiMeta } from "../utils/apiMeta.js";
import { fetchPaediatricReference } from "./pediatricTools.js";

/**
 * Paediatric assessment calculators, on chakudya-api (/paediatric/*), built from the BND 415 Clinical
 * Nutrition — Paediatric Medicine Resources sheet. They turn the reference tables into calculations
 * for one child. The tables and formulas live in the API (src/paediatric.js); these tools pass the
 * inputs through.
 *
 *   - pediatric_activity_stress_factor_reference  GET  /paediatric/reference?section=activity_factors | stress_factors
 *   - pediatric_growth_velocity_assessment        POST /paediatric/growth-velocity (term) or /paediatric/preterm (preterm)
 *   - pediatric_enteral_feed_plan                 POST /paediatric/enteral-feeds
 *
 * Only one calculation stays here: multiplying a BMR by factors the API returned, because no API route
 * takes a bare BMR. Educational/clinical-support only, not a substitute for individualized assessment.
 */

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

interface FactorDef {
  label: string;
  min: number;
  max: number;
  definition?: string;
}

/** The tool's activity keys match the API's, except the API calls the top level "vigorous". */
const ACTIVITY_KEY_TO_API: Record<string, string> = { high_or_vigorous: "vigorous" };

const round = (n: number, dp = 0) => Math.round(n * 10 ** dp) / 10 ** dp;

/** BMR x activity x stress, low/mid/high, from factor ranges the API returned. */
export function computeTeeFromFactors(args: {
  bmr_kcal_per_day: number;
  activity?: FactorDef;
  stress?: FactorDef;
  weight_kg?: number;
}) {
  const aLow = args.activity?.min ?? 1;
  const aHigh = args.activity?.max ?? 1;
  const sLow = args.stress?.min ?? 1;
  const sHigh = args.stress?.max ?? 1;
  const low = args.bmr_kcal_per_day * aLow * sLow;
  const high = args.bmr_kcal_per_day * aHigh * sHigh;
  const mid = args.bmr_kcal_per_day * ((aLow + aHigh) / 2) * ((sLow + sHigh) / 2);
  const perKg = (kcal: number) => (args.weight_kg ? round(kcal / args.weight_kg, 1) : undefined);
  return {
    bmr_kcal_per_day: args.bmr_kcal_per_day,
    activity_factor_range: args.activity ? { low: aLow, high: aHigh } : null,
    stress_factor_range: args.stress ? { low: sLow, high: sHigh } : null,
    tee_kcal_per_day: { low: Math.round(low), mid: Math.round(mid), high: Math.round(high) },
    tee_kcal_per_kg_per_day: args.weight_kg ? { low: perKg(low), mid: perKg(mid), high: perKg(high) } : undefined,
  };
}

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
      const [activityTable, stressTable] = (await Promise.all([
        fetchPaediatricReference("activity_factors"),
        fetchPaediatricReference("stress_factors"),
      ])) as [Record<string, FactorDef> | undefined, Record<string, FactorDef> | undefined];

      const activity = activity_level ? activityTable?.[ACTIVITY_KEY_TO_API[activity_level] ?? activity_level] : undefined;
      const stress = metabolic_condition ? stressTable?.[metabolic_condition] : undefined;

      if (bmr_kcal_per_day === undefined && !activity && !stress) {
        return okWithApiMeta({
          activity_factors: activityTable,
          stress_factors: stressTable,
          usage: "Estimated TEE = BMR x activity factor x stress factor (use only the factors that apply).",
        });
      }
      if (bmr_kcal_per_day === undefined) {
        return okWithApiMeta({
          activity: activity ?? null,
          stress: stress ?? null,
          note: "Add bmr_kcal_per_day to calculate a TEE range.",
        });
      }
      if (!activity && !stress) {
        return toolError("Give an activity_level and/or a metabolic_condition together with bmr_kcal_per_day.");
      }
      return okWithApiMeta({
        activity: activity ? { level: activity.label, definition: activity.definition } : null,
        stress: stress ? { condition: stress.label } : null,
        ...computeTeeFromFactors({ bmr_kcal_per_day, activity, stress, weight_kg }),
        note: "Factors are multiplied together, as in pediatric_energy_requirements. Low uses the lowest factors, high the highest.",
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
        "length/height in mm/day over interval_days, against the reference for the child's age and sex (infants " +
        "need sex; reference runs birth to under 11 years). PRETERM (population='preterm'): weight, length and head " +
        "circumference velocity plus initial weight loss and days to regain birth weight, against preterm targets.",
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
    safeTool("pediatric_growth_velocity_assessment", async (a) => {
      if (a.population === "preterm") {
        const kg = a.weight_end_kg ?? a.weight_start_kg ?? a.birth_weight_kg;
        if (kg === undefined) return toolError("Give at least one weight (weight_end_kg, weight_start_kg or birth_weight_kg) for a preterm assessment.");
        const res = await chakudyaClient.post("/paediatric/preterm", {
          weight_g: kg * 1000,
          monitoring: {
            birth_weight_g: a.birth_weight_kg !== undefined ? a.birth_weight_kg * 1000 : undefined,
            nadir_weight_g: a.lowest_weight_kg !== undefined ? a.lowest_weight_kg * 1000 : undefined,
            days_to_regain_birth_weight: a.days_to_regain_birth_weight,
            weight_g_start: a.weight_start_kg !== undefined ? a.weight_start_kg * 1000 : undefined,
            weight_g_end: a.weight_end_kg !== undefined ? a.weight_end_kg * 1000 : undefined,
            days: a.interval_days,
            length_cm_start: a.length_start_cm,
            length_cm_end: a.length_end_cm,
            hc_cm_start: a.head_circumference_start_cm,
            hc_cm_end: a.head_circumference_end_cm,
          },
        });
        return okWithApiMeta(res);
      }
      const res = await chakudyaClient.post("/paediatric/growth-velocity", {
        sex: a.sex,
        age_months: a.age_months,
        age_years: a.age_years,
        days: a.interval_days,
        weight_kg_start: a.weight_start_kg,
        weight_kg_end: a.weight_end_kg,
        length_cm_start: a.length_start_cm,
        length_cm_end: a.length_end_cm,
      });
      return okWithApiMeta(res);
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
        "Needs age, feed_type and weight_kg. Optionally give the formula's kcal/mL (formula_kcal_per_ml) and an " +
        "energy_target_kcal to see what the goal delivers. Use pediatric_enteral_feed_advancement to see the raw table.",
      inputSchema: {
        feed_type: z.enum(["continuous", "bolus"]),
        age_years: z.number().nonnegative().optional(),
        age_months: z.number().nonnegative().optional(),
        weight_kg: z.number().positive().optional(),
        formula_kcal_per_ml: z.number().positive().optional(),
        energy_target_kcal: z.number().positive().optional(),
      },
      annotations: READ_ONLY,
    },
    safeTool("pediatric_enteral_feed_plan", async ({ feed_type, age_years, age_months, weight_kg, formula_kcal_per_ml, energy_target_kcal }) => {
      if (age_years === undefined && age_months === undefined) return toolError("age_years or age_months is required.");
      if (weight_kg === undefined) return toolError("weight_kg is required.");
      const res = await chakudyaClient.post("/paediatric/enteral-feeds", {
        age_years,
        age_months,
        weight_kg,
        route: feed_type,
        formula_kcal_per_ml,
        energy_target_kcal,
      });
      return okWithApiMeta(res);
    })
  );
}
