import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, toolError, safeTool } from "../utils/toolResult.js";

/**
 * Carbohydrate counting and insulin dose adjustment for people with
 * diabetes on multiple daily injections, as compiled from a UK diabetes
 * network patient-education carbohydrate-counting guide (insulin-to-
 * carbohydrate ratio dosing, correction/insulin-sensitivity factor dosing,
 * background/quick-acting insulin profiles, and the stepwise dose
 * adjustment approach).
 *
 * Pure calculation / reference lookup — no Chakudya API calls.
 *
 * Six tools:
 *   - carbohydrate_content_calculator
 *   - carb_containing_foods_reference
 *   - handy_carb_measures_reference
 *   - mealtime_insulin_dose_calculator
 *   - insulin_types_reference
 *   - dose_adjustment_stepwise_reference
 */

const CARB_DISCLAIMER =
  "Patient-education reference and arithmetic only, adapted from a UK diabetes network carbohydrate-counting " +
  "and dose-adjustment guide. Insulin-to-carbohydrate ratios, correction/insulin-sensitivity factors, and " +
  "blood-glucose targets are individualized and must be agreed with the person's own diabetes team before " +
  "use — this tool does not set or validate a dose for a specific patient.";

function err(message: string) {
  return toolError(message);
}

// ── Foods affecting / not affecting blood glucose ───────────────────────────
const CARB_CONTAINING_FOODS = [
  "Bread, flour, flour based products and cereals",
  "Rice and pasta",
  "Crisps, rice cakes and crackers",
  "Couscous, barley and other grains",
  "Potato, sweet potato, yam and plantain",
  "Fruit (fresh, dried, frozen, tinned or fruit juice)",
  "Dairy foods (milk, yoghurt, ice cream)",
  "Biscuits, cakes and pastries",
  "Chocolate and sweets",
  "Sugar, syrup, honey, treacle, jam, marmalade",
  "Coated foods in batter or breadcrumbs",
  "Processed meat products",
  "Sugary drinks",
];

const NON_CARB_FOODS = [
  "Cooking oil",
  "Margarine",
  "Butter",
  "Cream",
  "Ghee",
  "Meat",
  "Fish",
  "Soya",
  "Tofu",
  "Quorn",
  "Eggs",
  "Cheese",
  "Nuts",
  "Salad, vegetables, beans and pulses",
];

const CARB_FOODS_TIPS = [
  "Vegetables other than potato, sweet potato, plantain and yam, plus beans and lentils, affect blood " +
    "glucose slowly and do not cause a significant rise — giving quick-acting insulin for these can cause " +
    "hypoglycaemia, so they are not usually counted initially.",
  "Sugary drinks raise blood glucose very quickly, are hard to match with quick-acting insulin, and are " +
    "best avoided day-to-day — but are a recommended treatment for hypoglycaemia.",
];

// ── Handy measures (~10g carbohydrate portions) ─────────────────────────────
const HANDY_MEASURES = [
  { measure: "1 egg-sized boiled potato", carb_g: 10 },
  { measure: "1 scoop mashed potato", carb_g: 10 },
  { measure: "4 medium cut chips", carb_g: 10 },
  { measure: "1 serving spoon cooked pasta", carb_g: 10 },
  { measure: "1 serving spoon cooked rice", carb_g: 10 },
  { measure: "1/3 pint of cow's milk", carb_g: 10 },
  { measure: "3 squares chocolate", carb_g: 10 },
  { measure: "1 scoop ice cream", carb_g: 10 },
  { measure: "1 funsize apple/pear", carb_g: 10 },
  { measure: "1 thin slice bread", carb_g: 10 },
  { measure: "1 medium slice bread", carb_g: 15 },
  { measure: "1 thick slice bread", carb_g: 20 },
];

const WEIGHING_RULES_OF_THUMB = [
  {
    food_group: "Bread products",
    rule: "Approximately half the total weight is carbohydrate.",
    divide_cooked_weight_by: 2,
    example: "A 50g slice of bread has roughly 25g carbohydrate.",
  },
  {
    food_group: "Pasta, rice, egg noodles and chips (cooked weight)",
    rule: "Approximately one third of the cooked weight is carbohydrate.",
    divide_cooked_weight_by: 3,
    example: "180g of cooked pasta has roughly 60g carbohydrate (180 / 3).",
  },
  {
    food_group: "Jacket potatoes (cooked weight)",
    rule: "Approximately one fifth of the cooked weight is carbohydrate.",
    divide_cooked_weight_by: 5,
    example: "A 200g cooked jacket potato has roughly 40g carbohydrate (200 / 5).",
  },
];

// ── Insulin types ────────────────────────────────────────────────────────────
const BACKGROUND_INSULINS = ["Toujeo", "Tresiba", "Levemir", "Lantus", "Insulatard", "Insuman Basal", "Humulin I"];

const QUICK_ACTING_INSULINS = [
  { name: "Novorapid", onset_minutes: "15-20", peak_minutes: 90, duration_hours: 4 },
  { name: "Humalog", onset_minutes: "15-20", peak_minutes: 90, duration_hours: 4 },
  { name: "Apidra", onset_minutes: "15-20", peak_minutes: 90, duration_hours: 4 },
  { name: "Fiasp", onset_minutes: "5-10", peak_minutes: 90, duration_hours: 4 },
];

// ── Stepwise approach ────────────────────────────────────────────────────────
const STEPWISE_APPROACH = [
  "Ensure your background insulin (BI) dose is correct.",
  "Identify which foods or drinks contain carbohydrate.",
  "Estimate the carbohydrate content of the meal or snack.",
  "Calculate the total quick-acting (QA) insulin dose required to match the carbohydrate in the meal or snack.",
  "Inject QA insulin.",
  "Record carbohydrate eaten, insulin given, and pre-meal blood glucose in a dose adjustment diary.",
  "Use the dose adjustment checklist to problem-solve out-of-range readings.",
];

const DOSE_ADJUSTMENT_CHECKLIST = [
  "Identify which blood glucose reading (time of day) is out of target.",
  "Exclude other causes for the out-of-range reading before adjusting insulin (illness, activity, alcohol, missed dose, site rotation, etc).",
  "Wait for a pattern over roughly 48 hours before adjusting — the exception is a night-time hypo, which should prompt an immediate reduction to background insulin.",
  "Decide which insulin needs adjusting: background insulin (affects the whole day/overnight baseline) or quick-acting insulin ratio at a specific meal.",
  "Adjust background insulin by 1-2 units (10-20%), or the insulin-to-carbohydrate ratio by half a unit per 10g, at a time.",
  "Continue monitoring and recording blood glucose to confirm the adjustment worked before making a further change.",
];

export function registerCarbCountingDoseAdjustmentTools(server: McpServer) {
  // ── carbohydrate_content_calculator ─────────────────────────────────────
  server.registerTool(
    "carbohydrate_content_calculator",
    {
      title: "Carbohydrate Content Calculator",
      description:
        "Compute the carbohydrate content of a weighed portion of food from its food-label carbohydrate-per-100g " +
        "value: carb_in_portion_g = (carb_per_100g / 100) x portion_weight_g. Optionally provide a " +
        "target_carb_g instead of portion_weight_g to solve in reverse for the portion weight needed to hit a " +
        "carbohydrate target. Provide exactly one of portion_weight_g or target_carb_g.",
      inputSchema: {
        carb_per_100g: z.number().nonnegative().describe("Carbohydrate (g) per 100g, from the food label — use 'Carbohydrate', not 'of which sugars'."),
        portion_weight_g: z.number().positive().optional().describe("Weighed portion size in grams. Omit if using target_carb_g instead."),
        target_carb_g: z.number().positive().optional().describe("Desired carbohydrate amount in grams; solves for the portion weight needed. Omit if using portion_weight_g instead."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool(
      "carbohydrate_content_calculator",
      async ({ carb_per_100g, portion_weight_g, target_carb_g }) => {
        if (portion_weight_g === undefined && target_carb_g === undefined) {
          return err("Provide either portion_weight_g or target_carb_g.");
        }
        if (portion_weight_g !== undefined && target_carb_g !== undefined) {
          return err("Provide only one of portion_weight_g or target_carb_g, not both.");
        }

        if (portion_weight_g !== undefined) {
          const carbInPortion = (carb_per_100g / 100) * portion_weight_g;
          return ok(
            {
              carb_per_100g,
              portion_weight_g,
              carb_in_portion_g: Math.round(carbInPortion * 10) / 10,
              formula: "(carb_per_100g / 100) x portion_weight_g",
            },
            { disclaimer: CARB_DISCLAIMER }
          );
        }

        if (carb_per_100g === 0) {
          return err("carb_per_100g is 0 — cannot solve for a portion weight with zero carbohydrate density.");
        }
        const neededWeight = (target_carb_g! / carb_per_100g) * 100;
        return ok(
          {
            carb_per_100g,
            target_carb_g,
            required_portion_weight_g: Math.round(neededWeight * 10) / 10,
            formula: "(target_carb_g / carb_per_100g) x 100",
          },
          { disclaimer: CARB_DISCLAIMER }
        );
      }
    )
  );

  // ── carb_containing_foods_reference ─────────────────────────────────────
  server.registerTool(
    "carb_containing_foods_reference",
    {
      title: "Carbohydrate-Containing Foods Reference",
      description:
        "Look up which food groups raise blood glucose and require quick-acting insulin matching, versus " +
        "which food groups (fat, protein, most vegetables) do not. Includes tips on non-starchy vegetables/" +
        "pulses and sugary drinks. Returns both lists and tips by default.",
      inputSchema: {
        list: z.enum(["affects_blood_glucose", "does_not_affect_blood_glucose"]).optional().describe("Optionally restrict to just one list."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("carb_containing_foods_reference", async ({ list }) => {
      if (list === "affects_blood_glucose") {
        return ok({ affects_blood_glucose: CARB_CONTAINING_FOODS }, { disclaimer: CARB_DISCLAIMER });
      }
      if (list === "does_not_affect_blood_glucose") {
        return ok({ does_not_affect_blood_glucose: NON_CARB_FOODS }, { disclaimer: CARB_DISCLAIMER });
      }
      return ok(
        {
          affects_blood_glucose: CARB_CONTAINING_FOODS,
          does_not_affect_blood_glucose: NON_CARB_FOODS,
          tips: CARB_FOODS_TIPS,
        },
        { disclaimer: CARB_DISCLAIMER }
      );
    })
  );

  // ── handy_carb_measures_reference ───────────────────────────────────────
  server.registerTool(
    "handy_carb_measures_reference",
    {
      title: "Handy Carbohydrate Measures & Weighing Rules Reference",
      description:
        "Look up quick everyday carbohydrate estimates (e.g. '1 thin slice bread = 10g carbohydrate') and the " +
        "weighing rules of thumb for bread, pasta/rice/noodles/chips, and jacket potatoes (fraction of cooked " +
        "weight that is carbohydrate). Useful when a food label isn't available.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("handy_carb_measures_reference", async () => {
      return ok(
        { handy_measures: HANDY_MEASURES, weighing_rules_of_thumb: WEIGHING_RULES_OF_THUMB },
        { disclaimer: CARB_DISCLAIMER }
      );
    })
  );

  // ── mealtime_insulin_dose_calculator ────────────────────────────────────
  server.registerTool(
    "mealtime_insulin_dose_calculator",
    {
      title: "Mealtime Insulin Dose Calculator (ICR + Correction)",
      description:
        "Compute a total quick-acting (QA) mealtime insulin dose from two components: (1) a carb dose = " +
        "(total_carb_g / 10) x icr_units_per_10g, matching the insulin-to-carbohydrate ratio (ICR); and " +
        "(2) an optional correction dose = (current_bg_mmol_l - target_bg_midpoint) / isf_mmol_l_per_unit, " +
        "matching the correction/insulin-sensitivity factor (ISF). Provide current_bg_mmol_l with " +
        "target_bg_low_mmol_l and target_bg_high_mmol_l to include a correction; omit them to get the carb " +
        "dose only. isf_mmol_l_per_unit defaults to 2.5 (midpoint of the typical 2-3 mmol/L per unit range) " +
        "if a correction is requested but no ISF is supplied. This mirrors a worked example: 50g carbohydrate " +
        "at a 1u:10g ratio = 5 units, plus a BG of 12 mmol/L against a 6-8 mmol/L target at ISF 2.5 = " +
        "2 correction units, for a total of 7 units.",
      inputSchema: {
        total_carb_g: z.number().nonnegative().describe("Total carbohydrate in the meal/snack, in grams."),
        icr_units_per_10g: z.number().positive().describe("Insulin-to-carbohydrate ratio, in QA units per 10g carbohydrate (e.g. 1 for a 1u:10g ratio, 1.5 for 1.5u:10g)."),
        current_bg_mmol_l: z.number().positive().optional().describe("Current blood glucose in mmol/L. Provide together with the target range to add a correction dose."),
        target_bg_low_mmol_l: z.number().positive().optional().describe("Lower bound of the pre-meal/before-bed target blood glucose range, mmol/L."),
        target_bg_high_mmol_l: z.number().positive().optional().describe("Upper bound of the pre-meal/before-bed target blood glucose range, mmol/L."),
        isf_mmol_l_per_unit: z.number().positive().optional().describe("Correction/insulin sensitivity factor: mmol/L that 1 unit of QA insulin lowers blood glucose by. Defaults to 2.5 if omitted and a correction is being calculated."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool(
      "mealtime_insulin_dose_calculator",
      async ({
        total_carb_g,
        icr_units_per_10g,
        current_bg_mmol_l,
        target_bg_low_mmol_l,
        target_bg_high_mmol_l,
        isf_mmol_l_per_unit,
      }) => {
        const carbDose = (total_carb_g / 10) * icr_units_per_10g;

        const wantsCorrection =
          current_bg_mmol_l !== undefined || target_bg_low_mmol_l !== undefined || target_bg_high_mmol_l !== undefined;

        if (!wantsCorrection) {
          return ok(
            {
              total_carb_g,
              icr_units_per_10g,
              carb_dose_units: Math.round(carbDose * 2) / 2,
              correction_dose_units: 0,
              total_qa_dose_units: Math.round(carbDose * 2) / 2,
              formula_carb_dose: "(total_carb_g / 10) x icr_units_per_10g",
            },
            { disclaimer: CARB_DISCLAIMER }
          );
        }

        if (current_bg_mmol_l === undefined || target_bg_low_mmol_l === undefined || target_bg_high_mmol_l === undefined) {
          return err(
            "To include a correction dose, provide all three of current_bg_mmol_l, target_bg_low_mmol_l, and target_bg_high_mmol_l."
          );
        }
        if (target_bg_low_mmol_l >= target_bg_high_mmol_l) {
          return err("target_bg_low_mmol_l must be less than target_bg_high_mmol_l.");
        }

        const isf = isf_mmol_l_per_unit ?? 2.5;
        const targetMidpoint = (target_bg_low_mmol_l + target_bg_high_mmol_l) / 2;
        const correctionDose = (current_bg_mmol_l - targetMidpoint) / isf;
        const totalDose = carbDose + correctionDose;

        return ok(
          {
            total_carb_g,
            icr_units_per_10g,
            carb_dose_units: Math.round(carbDose * 2) / 2,
            current_bg_mmol_l,
            target_bg_range_mmol_l: [target_bg_low_mmol_l, target_bg_high_mmol_l],
            target_bg_midpoint_mmol_l: targetMidpoint,
            isf_mmol_l_per_unit: isf,
            correction_dose_units: Math.round(correctionDose * 2) / 2,
            total_qa_dose_units: Math.round(totalDose * 2) / 2,
            formula_carb_dose: "(total_carb_g / 10) x icr_units_per_10g",
            formula_correction_dose: "(current_bg_mmol_l - target_bg_midpoint) / isf_mmol_l_per_unit",
            note:
              correctionDose < 0
                ? "current_bg_mmol_l is below the target midpoint — the negative correction reduces the total dose below the carb dose alone (do not correct below 0 units; discuss low readings with the diabetes team)."
                : "Corrections should only be given at mealtimes or before bed (if 4+ hours since the last quick-acting dose), to avoid stacking doses.",
          },
          { disclaimer: CARB_DISCLAIMER }
        );
      }
    )
  );

  // ── insulin_types_reference ──────────────────────────────────────────────
  server.registerTool(
    "insulin_types_reference",
    {
      title: "Background & Quick-Acting Insulin Types Reference",
      description:
        "Look up common background (basal) insulin names (Toujeo, Tresiba, Levemir, Lantus, Insulatard, " +
        "Insuman Basal, Humulin I) and quick-acting insulin names with their onset/peak/duration profile " +
        "(Novorapid, Humalog, Apidra: onset 15-20 min; Fiasp: onset 5-10 min; all peak around 90 minutes " +
        "with a roughly 4-hour duration). Quick-acting insulin should generally be injected around 15 " +
        "minutes before eating (Fiasp can be closer to eating time) — discuss timing with the diabetes team.",
      inputSchema: {
        category: z.enum(["background", "quick_acting"]).optional().describe("Optionally restrict to one category."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("insulin_types_reference", async ({ category }) => {
      if (category === "background") {
        return ok({ background_insulins: BACKGROUND_INSULINS }, { disclaimer: CARB_DISCLAIMER });
      }
      if (category === "quick_acting") {
        return ok({ quick_acting_insulins: QUICK_ACTING_INSULINS }, { disclaimer: CARB_DISCLAIMER });
      }
      return ok(
        { background_insulins: BACKGROUND_INSULINS, quick_acting_insulins: QUICK_ACTING_INSULINS },
        { disclaimer: CARB_DISCLAIMER }
      );
    })
  );

  // ── dose_adjustment_stepwise_reference ──────────────────────────────────
  server.registerTool(
    "dose_adjustment_stepwise_reference",
    {
      title: "Stepwise Carbohydrate Counting & Dose Adjustment Reference",
      description:
        "Look up the 7-step stepwise approach to carbohydrate counting and dose adjustment (from checking " +
        "background insulin through to using a dose adjustment diary and troubleshooting checklist), and/or " +
        "the dose adjustment checklist for problem-solving out-of-range blood glucose readings.",
      inputSchema: {
        section: z.enum(["stepwise_approach", "dose_adjustment_checklist"]).optional().describe("Optionally restrict to one section."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("dose_adjustment_stepwise_reference", async ({ section }) => {
      if (section === "stepwise_approach") {
        return ok({ stepwise_approach: STEPWISE_APPROACH }, { disclaimer: CARB_DISCLAIMER });
      }
      if (section === "dose_adjustment_checklist") {
        return ok({ dose_adjustment_checklist: DOSE_ADJUSTMENT_CHECKLIST }, { disclaimer: CARB_DISCLAIMER });
      }
      return ok(
        { stepwise_approach: STEPWISE_APPROACH, dose_adjustment_checklist: DOSE_ADJUSTMENT_CHECKLIST },
        { disclaimer: CARB_DISCLAIMER }
      );
    })
  );
}
