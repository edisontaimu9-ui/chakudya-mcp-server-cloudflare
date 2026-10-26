import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { chakudyaClient } from "../clients/chakudyaClient.js";
import { safeTool } from "../utils/toolResult.js";
import { okWithApiMeta } from "../utils/apiMeta.js";

/**
 * Carbohydrate counting and insulin dose adjustment for people with
 * diabetes on multiple daily injections, as compiled from a UK diabetes
 * network patient-education carbohydrate-counting guide (insulin-to-
 * carbohydrate ratio dosing, correction/insulin-sensitivity factor dosing,
 * background/quick-acting insulin profiles, and the stepwise dose
 * adjustment approach).
 *
 * Six tools:
 *   - carbohydrate_content_calculator
 *   - carb_containing_foods_reference
 *   - handy_carb_measures_reference
 *   - mealtime_insulin_dose_calculator
 *   - insulin_types_reference
 *   - dose_adjustment_stepwise_reference
 *
 * The logic and every list, measure, insulin profile, default and text now
 * live in chakudya-api (src/carbCounting.js, /carb-counting/*), with the
 * values read from the clinical_reference_values table (condition
 * 'carb_counting'), so the API is the single source of truth and values can
 * be corrected in Supabase without redeploying this server. These tools only
 * pass the inputs through.
 *
 * Patient-education reference and arithmetic only: ratios, correction
 * factors and targets must be agreed with the person's own diabetes team.
 */

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

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
      annotations: READ,
    },
    safeTool("carbohydrate_content_calculator", async (input) => {
      const res = await chakudyaClient.post("/carb-counting/carbohydrate-content", input);
      return okWithApiMeta(res);
    })
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
      annotations: READ,
    },
    safeTool("carb_containing_foods_reference", async ({ list }) => {
      const res = await chakudyaClient.get("/carb-counting/foods", { list });
      return okWithApiMeta(res);
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
      annotations: READ,
    },
    safeTool("handy_carb_measures_reference", async () => {
      const res = await chakudyaClient.get("/carb-counting/handy-measures");
      return okWithApiMeta(res);
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
        "if a correction is requested but no ISF is supplied. A blood glucose below the target midpoint gives " +
        "a correction of 0 (it never reduces the carb dose). This mirrors a worked example: 50g carbohydrate " +
        "at a 1u:10g ratio = 5 units, plus a BG of 12 mmol/L against a 6-8 mmol/L target at ISF 2.5 = " +
        "2 correction units, for a total of 7 units. Starting estimate only: the ratio, ISF and targets belong " +
        "to the person's diabetes team.",
      inputSchema: {
        total_carb_g: z.number().nonnegative().describe("Total carbohydrate in the meal/snack, in grams."),
        icr_units_per_10g: z.number().positive().describe("Insulin-to-carbohydrate ratio, in QA units per 10g carbohydrate (e.g. 1 for a 1u:10g ratio, 1.5 for 1.5u:10g)."),
        current_bg_mmol_l: z.number().positive().optional().describe("Current blood glucose in mmol/L. Provide together with the target range to add a correction dose."),
        target_bg_low_mmol_l: z.number().positive().optional().describe("Lower bound of the pre-meal/before-bed target blood glucose range, mmol/L."),
        target_bg_high_mmol_l: z.number().positive().optional().describe("Upper bound of the pre-meal/before-bed target blood glucose range, mmol/L."),
        isf_mmol_l_per_unit: z.number().positive().optional().describe("Correction/insulin sensitivity factor: mmol/L that 1 unit of QA insulin lowers blood glucose by. Defaults to 2.5 if omitted and a correction is being calculated."),
      },
      annotations: READ,
    },
    safeTool("mealtime_insulin_dose_calculator", async (input) => {
      const res = await chakudyaClient.post("/carb-counting/insulin-dose", input);
      return okWithApiMeta(res);
    })
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
      annotations: READ,
    },
    safeTool("insulin_types_reference", async ({ category }) => {
      const res = await chakudyaClient.get("/carb-counting/insulin-types", { category });
      return okWithApiMeta(res);
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
      annotations: READ,
    },
    safeTool("dose_adjustment_stepwise_reference", async ({ section }) => {
      const res = await chakudyaClient.get("/carb-counting/dose-adjustment", { section });
      return okWithApiMeta(res);
    })
  );
}
