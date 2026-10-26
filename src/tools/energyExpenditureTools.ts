import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { chakudyaClient } from "../clients/chakudyaClient.js";
import { ok, safeTool, toolError } from "../utils/toolResult.js";
import { okWithApiMeta } from "../utils/apiMeta.js";

/**
 * Energy expenditure calculators sourced from Nelms/Ireton-Jones, "Nutrition Therapy and
 * Pathophysiology" / Krause and Mahan chapter 2 "Intake: Energy": Institute of Medicine (2002/2005)
 * DRI/EER prediction equations (Box 2.1, Tables 2.2-2.4).
 *
 * The equations and tables live in the API (src/energyEngine.js, src/foodEnergy.js) and these tools
 * read them from there, so there is one copy to correct.
 *
 *   - iom_dri_eer_calculator            POST /energy/requirements
 *   - met_activity_energy_calculator    GET  /energy/factors (Table 2.4 METs), then MET x kg x hours
 *   - alcohol_kcal_calculator           POST /energy/food-energy
 *   - respiratory_quotient_interpreter  local (no API route takes a bare RQ)
 *   - tee_activity_band_estimator       GET  /energy/factors (activity bands), then REE x (1 + band)
 *   - fever_stress_ree_adjustment       POST /stress-factors/fever
 *   - atwater_food_energy_calculator    POST /energy/food-energy
 *   - dri_eer_reference_lookup          GET  /energy/factors (Table 2.2)
 *
 * Educational/clinical-support estimate only, not a substitute for individualized dietetic assessment
 * or measured indirect calorimetry.
 */

const DISCLAIMER =
  "Estimate only, derived from IOM/DRI published prediction equations. Individual variation may be wide; " +
  "measured indirect calorimetry is preferred when available and clinically indicated.";

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

interface EnergyFactors {
  source?: string;
  activity_factors?: Array<{ id: string; label: string; min: number; max: number }>;
  activities?: Array<{ id: string; label: string; mets: number }>;
  dri_reference_eer?: Array<{ group: string; [k: string]: unknown }>;
}

/** The API's factor and reference catalogue (GET /energy/factors). */
async function fetchEnergyFactors(): Promise<EnergyFactors> {
  const res = await chakudyaClient.get("/energy/factors");
  return ((res as { data?: EnergyFactors }).data ?? {}) as EnergyFactors;
}

/** Three activity ids were spelled differently in this tool before it moved to the API's table. */
const MET_ACTIVITY_ALIASES: Record<string, string> = {
  mowing_lawn_power: "mowing_lawn_power_mower",
  skiing_downhill_or_water: "skiing",
  jogging_10min_mile: "jogging_10_min_mile",
};

const FEMALE_LIFE_STAGE = /girl|female|pregnant|lactating/;
const TRIMESTER = { first: 1, second: 2, third: 3 } as const;
/** The API takes months since delivery; each half-year label is sent as its midpoint. */
const MONTHS_POSTPARTUM = { first_6_months: 3, second_6_months: 9 } as const;

export function registerEnergyExpenditureTools(server: McpServer) {
  // ── iom_dri_eer_calculator ────────────────────────────────────────────────
  server.registerTool(
    "iom_dri_eer_calculator",
    {
      title: "IOM/DRI Estimated Energy Requirement (EER) Calculator",
      description:
        "Compute Estimated Energy Requirement using the Institute of Medicine (2002/2005) DRI prediction " +
        "equations (Box 2.1), covering infants 0-2y (weight only), children 3-18y, adults 19+ and pregnant/" +
        "lactating women. The API picks the equation that applies from age, sex and BMI (normal-weight, " +
        "overweight/obese or combined) and returns every applicable estimate plus one recommended figure, " +
        "so life_stage is used for the sex, pregnancy and lactation settings. Give age_months for infants, " +
        "age_years and height_cm for everyone else, trimester for pregnancy and months_postpartum for lactation.",
      inputSchema: {
        life_stage: z.enum([
          "infant_0_2y",
          "child_boy_3_8_normal",
          "child_boy_9_18_normal",
          "child_girl_3_8_normal",
          "child_girl_9_18_normal",
          "child_boy_3_18_overweight",
          "child_girl_3_18_overweight",
          "adult_male_normal_bmi18_5_25",
          "adult_female_normal_bmi18_25",
          "adult_male_overweight_obese_bmi25plus",
          "adult_female_overweight_obese_bmi25plus",
          "adult_male_combined_bmi18_5plus",
          "adult_female_combined_bmi18_5plus",
          "pregnant_14_18",
          "pregnant_19_50",
          "lactating_14_18",
          "lactating_19_50",
        ]),
        weight_kg: z.number().positive(),
        height_cm: z.number().positive().optional().describe("Required for all life stages except infant_0_2y"),
        age_years: z.number().nonnegative().optional().describe("Required for all life stages except infant_0_2y"),
        age_months: z.number().nonnegative().optional().describe("Required for infant_0_2y (0-35 months)"),
        sex: z.enum(["male", "female"]).optional().describe("Only for infant_0_2y, where it does not change the result; every other life stage implies it"),
        physical_activity_level: z
          .enum(["sedentary", "low_active", "active", "very_active"])
          .optional()
          .default("sedentary")
          .describe("Used for every life stage except infant_0_2y"),
        trimester: z.enum(["first", "second", "third"]).optional().describe("Required for pregnant_14_18 / pregnant_19_50"),
        months_postpartum: z
          .enum(["first_6_months", "second_6_months"])
          .optional()
          .describe("Required for lactating_14_18 / lactating_19_50"),
      },
      annotations: READ,
    },
    safeTool(
      "iom_dri_eer_calculator",
      async ({ life_stage, weight_kg, height_cm, age_years, age_months, sex, physical_activity_level, trimester, months_postpartum }) => {
        const infant = life_stage === "infant_0_2y";
        const pregnant = life_stage.startsWith("pregnant_");
        const lactating = life_stage.startsWith("lactating_");
        if (infant && age_months === undefined && age_years === undefined) return toolError("age_months (or age_years) is required for infant_0_2y.");
        if (pregnant && !trimester) return toolError("trimester (first/second/third) is required for pregnancy life stages.");
        if (lactating && !months_postpartum) return toolError("months_postpartum (first_6_months/second_6_months) is required for lactation life stages.");

        const res = await chakudyaClient.post("/energy/requirements", {
          sex: infant ? (sex ?? "male") : FEMALE_LIFE_STAGE.test(life_stage) ? "female" : "male",
          weight_kg,
          height_cm,
          age_years,
          age_months,
          pal_category: infant ? undefined : physical_activity_level,
          pregnancy: pregnant && trimester ? { trimester: TRIMESTER[trimester] } : undefined,
          lactation: lactating && months_postpartum ? { months_postpartum: MONTHS_POSTPARTUM[months_postpartum] } : undefined,
        });
        return okWithApiMeta(res);
      }
    )
  );

  // ── met_activity_energy_calculator ────────────────────────────────────────
  server.registerTool(
    "met_activity_energy_calculator",
    {
      title: "MET-Based Activity Energy Expenditure Calculator",
      description:
        "Estimate kcal expended during a physical activity using its metabolic equivalent (MET) value: " +
        "kcal = MET x weight(kg) x duration(hours). Pick a known activity from Table 2.4 via `activity` " +
        "(an id such as walking_3mph, swimming or cycling_moderate; energy_factors_reference lists them all), " +
        "or supply a custom `met_value` for an activity not in the table.",
      inputSchema: {
        weight_kg: z.number().positive(),
        duration_minutes: z.number().positive(),
        activity: z.string().optional().describe("A Table 2.4 activity id, e.g. walking_3mph, swimming, cycling_moderate"),
        met_value: z.number().positive().optional().describe("Custom MET value, used if `activity` is omitted"),
      },
      annotations: READ,
    },
    safeTool("met_activity_energy_calculator", async ({ weight_kg, duration_minutes, activity, met_value }) => {
      let mets = met_value;
      let activityId = "custom";
      if (activity) {
        const wanted = MET_ACTIVITY_ALIASES[activity] ?? activity;
        const table = (await fetchEnergyFactors()).activities ?? [];
        const row = table.find((a) => a.id === wanted);
        if (!row) return toolError(`Unknown activity "${activity}". Valid ids: ${table.map((a) => a.id).join(", ") || "(none returned by the API)"}.`);
        mets = row.mets;
        activityId = row.id;
      }
      if (mets === undefined) return toolError("Provide either `activity` or `met_value`.");
      const kcal = mets * weight_kg * (duration_minutes / 60);
      return ok({
        activity: activityId,
        met_value: mets,
        weight_kg,
        duration_minutes,
        kcal_expended: Math.round(kcal * 10) / 10,
        disclaimer: DISCLAIMER,
      });
    })
  );

  // ── alcohol_kcal_calculator ───────────────────────────────────────────────
  server.registerTool(
    "alcohol_kcal_calculator",
    {
      title: "Alcoholic Beverage Calorie Calculator",
      description:
        "Compute kcal in an alcoholic beverage from volume (oz) and proof: " +
        "kcal = volume_oz x proof x 0.8. Proof is the US convention where 100-proof = 50% ethyl alcohol by " +
        "volume (i.e. pass the proof number itself, e.g. 86, not a fraction).",
      inputSchema: {
        volume_oz: z.number().positive(),
        proof: z.number().positive(),
      },
      annotations: READ,
    },
    safeTool("alcohol_kcal_calculator", async ({ volume_oz, proof }) => {
      const res = await chakudyaClient.post("/energy/food-energy", { alcohol: { volume_oz, proof } });
      return okWithApiMeta(res);
    })
  );

  // ── respiratory_quotient_interpreter ──────────────────────────────────────
  // No API route interprets a bare RQ (the engine reads VO2 and VCO2 inside a full requirements request),
  // so this one stays local.
  server.registerTool(
    "respiratory_quotient_interpreter",
    {
      title: "Respiratory Quotient (RQ) Interpreter",
      description:
        "Interpret a measured respiratory quotient (RQ = VCO2/VO2) from indirect calorimetry against the " +
        "reference fuel-mixture values: 1.0=carbohydrate, 0.85=mixed diet, 0.82=protein, 0.7=fat, " +
        "<=0.65=ketone production. Values >1 suggest net fat synthesis / excess carbohydrate or total " +
        "caloric intake; very low values may indicate inadequate nutrient intake. Note: per McClave et al " +
        "(2003), RQ has low sensitivity/specificity for detecting over/underfeeding in practice and is best " +
        "used as a marker of measurement validity (confirming RQ is in the physiologic 0.65-1.2 range).",
      inputSchema: {
        rq: z.number().positive(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("respiratory_quotient_interpreter", async ({ rq }) => {
      let interpretation: string;
      let closestReference: string;

      if (rq > 1) {
        interpretation =
          "RQ > 1: suggests net fat synthesis (lipogenesis), high carbohydrate/glucose intake, or excessive " +
          "total caloric intake (overfeeding).";
        closestReference = "above carbohydrate (1.0)";
      } else if (rq >= 0.92) {
        interpretation = "Close to 1.0 — fuel mixture weighted toward carbohydrate oxidation.";
        closestReference = "carbohydrate (1.0)";
      } else if (rq >= 0.78) {
        interpretation = "Close to 0.85 — consistent with a mixed diet (typical resting fuel mixture).";
        closestReference = "mixed diet (0.85)";
      } else if (rq >= 0.72) {
        interpretation = "Close to 0.7-0.82 — fuel mixture weighted toward fat/protein oxidation.";
        closestReference = "fat (0.7) / protein (0.82)";
      } else if (rq > 0.65) {
        interpretation =
          "Approaching 0.65 — fuel mixture heavily weighted toward fat oxidation; may reflect inadequate " +
          "nutrient/caloric intake.";
        closestReference = "fat (0.7), trending toward ketone production";
      } else {
        interpretation =
          "RQ <= 0.65: consistent with ketone production, typically seen with markedly inadequate nutrient " +
          "intake (e.g. starvation, severe underfeeding).";
        closestReference = "ketone production (<=0.65)";
      }

      return ok({
        rq,
        closest_reference_value: closestReference,
        interpretation,
        note:
          "RQ has been shown to correlate poorly with percent calories provided/required in hospitalized " +
          "patients (McClave et al, 2003) — use primarily to confirm the measurement is physiologically " +
          "plausible rather than to titrate feeding.",
        disclaimer: DISCLAIMER,
      });
    })
  );

  // ── tee_activity_band_estimator ───────────────────────────────────────────
  server.registerTool(
    "tee_activity_band_estimator",
    {
      title: "TEE Activity-Band Estimator (Simplified)",
      description:
        "Estimate Total Energy Expenditure from a known/measured REE using the simplified activity-level " +
        "banding method (Nelms/Ireton-Jones Ch.2): minimal activity = REE x 1.10-1.20, moderate = REE x " +
        "1.25-1.40, strenuous = REE x 1.45-1.60. These ranges are described in the source as expert opinion " +
        "rather than evidence-based, and are a quicker bedside alternative to the full IOM/DRI prediction " +
        "equations when you already have a predicted or measured REE. The bands are read from the API.",
      inputSchema: {
        ree_kcal_per_day: z.number().positive(),
        activity_level: z.enum(["minimal", "moderate", "strenuous"]),
      },
      annotations: READ,
    },
    safeTool("tee_activity_band_estimator", async ({ ree_kcal_per_day, activity_level }) => {
      const band = (await fetchEnergyFactors()).activity_factors?.find((f) => f.id === activity_level);
      if (!band) return toolError(`The API returned no activity band for "${activity_level}".`);
      const low = 1 + band.min;
      const high = 1 + band.max;
      return ok({
        ree_kcal_per_day,
        activity_level,
        multiplier_range: [Math.round(low * 100) / 100, Math.round(high * 100) / 100],
        tee_kcal_per_day_estimate: {
          low: Math.round(ree_kcal_per_day * low),
          high: Math.round(ree_kcal_per_day * high),
        },
        note: "Ranges are expert opinion rather than evidence-based (Nelms/Ireton-Jones Ch.2).",
        disclaimer: DISCLAIMER,
      });
    })
  );

  // ── fever_stress_ree_adjustment ───────────────────────────────────────────
  server.registerTool(
    "fever_stress_ree_adjustment",
    {
      title: "Fever REE Adjustment",
      description:
        "Adjust a baseline REE for fever, per the classic Hardy & DuBois relationship cited in " +
        "Nelms/Ireton-Jones Ch.2: REE increases ~7% for each degree F above 98.6°F, or ~13% for each " +
        "degree C above 37°C. Provide body_temp_f or body_temp_c. Returns 0% adjustment if temperature is " +
        "at or below normal.",
      inputSchema: {
        ree_kcal_per_day: z.number().positive(),
        body_temp_f: z.number().optional(),
        body_temp_c: z.number().optional(),
      },
      annotations: READ,
    },
    safeTool("fever_stress_ree_adjustment", async (input) => {
      const res = await chakudyaClient.post("/stress-factors/fever", input);
      return okWithApiMeta(res);
    })
  );

  // ── atwater_food_energy_calculator ────────────────────────────────────────
  server.registerTool(
    "atwater_food_energy_calculator",
    {
      title: "Atwater Food Energy Calculator",
      description:
        "Compute total kcal and macronutrient % breakdown from grams of protein, fat, carbohydrate, and " +
        "(optionally) alcohol, using the Atwater factors (4/9/4/7 kcal/g respectively). Useful for a manually " +
        "specified recipe or formulated feed, as opposed to calculate_nutrients which pulls per-100g values " +
        "from the Chakudya food database.",
      inputSchema: {
        protein_g: z.number().nonnegative().default(0),
        fat_g: z.number().nonnegative().default(0),
        carbohydrate_g: z.number().nonnegative().default(0),
        alcohol_g: z.number().nonnegative().default(0),
      },
      annotations: READ,
    },
    safeTool("atwater_food_energy_calculator", async ({ protein_g, fat_g, carbohydrate_g, alcohol_g }) => {
      const res = await chakudyaClient.post("/energy/food-energy", { protein_g, fat_g, carbohydrate_g, alcohol_g });
      return okWithApiMeta(res);
    })
  );

  // ── dri_eer_reference_lookup ──────────────────────────────────────────────
  server.registerTool(
    "dri_eer_reference_lookup",
    {
      title: "DRI EER Reference Lookup (Table 2.2)",
      description:
        "Look up the published DRI reference EER (kcal/day) for a healthy, active person of reference " +
        "height/weight at a given life stage (Table 2.2) — infants through adults, pregnant, and lactating " +
        "women. This is a quick sanity-check reference table, not a per-patient calculation; use " +
        "iom_dri_eer_calculator for an individualized estimate. Pass a search term matching part of a group " +
        "label (e.g. 'adult', '3-8', 'lactating 19-50 first'); omit to return the full table.",
      inputSchema: {
        life_stage_search: z.string().optional(),
      },
      annotations: READ,
    },
    safeTool("dri_eer_reference_lookup", async ({ life_stage_search }) => {
      const factors = await fetchEnergyFactors();
      const table = factors.dri_reference_eer ?? [];
      const needle = life_stage_search?.toLowerCase();
      const rows = needle ? table.filter((r) => r.group.toLowerCase().includes(needle)) : table;
      if (rows.length === 0) return toolError(`No life stage matched "${life_stage_search}". Omit life_stage_search to see the full table.`);
      return ok({
        source: "IOM/DRI (2002/2005) Table 2.2 — reference EER for active individuals at reference height/weight",
        results: rows,
        disclaimer: DISCLAIMER,
      });
    })
  );
}
