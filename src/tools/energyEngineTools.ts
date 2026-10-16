import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { chakudyaClient } from "../clients/chakudyaClient.js";
import { ok, safeTool } from "../utils/toolResult.js";

/**
 * Energy engine on chakudya-api (Krause 16th ed. ch. 2 / Appendix 10): /energy/factors,
 * /energy/requirements, /energy/food-energy and /activity-energy (+ /calculate).
 */
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

export function registerEnergyEngineTools(server: McpServer) {
  server.registerTool(
    "energy_factors_reference",
    {
      title: "Energy Engine Factors and Equations",
      description:
        "List the factors, equations and reference tables behind Chakudya's energy engine (activity levels, PAL categories, " +
        "stress factors, IOM equations). Read this to see which stress ids and PAL values energy_requirements accepts.",
      inputSchema: {},
      annotations: READ,
    },
    safeTool("energy_factors_reference", async () => {
      const res = await chakudyaClient.get("/energy/factors");
      return ok(res.data ?? res);
    })
  );

  server.registerTool(
    "energy_requirements",
    {
      title: "Energy Requirements (Chakudya engine)",
      description:
        "Estimate energy needs with Chakudya's engine: Mifflin-St Jeor or measured REE, stress factors (fever, custom), activity " +
        "factor/PAL/activity log, and the IOM EER equations for every age group including pregnancy and lactation. Returns one " +
        "recommended figure with the reason, every step, and other applicable estimates. Needs sex, age and weight/height. " +
        "Children 3-18 y with weight and height get their BMI percentile looked up from the WHO tables. Call " +
        "energy_factors_reference for valid ids. Estimate only; confirm clinically.",
      inputSchema: {
        sex: z.enum(["male", "female"]),
        age_years: z.number().nonnegative().optional(),
        age_months: z.number().int().nonnegative().optional(),
        weight_kg: z.number().positive(),
        height_cm: z.number().positive().optional(),
        height_m: z.number().positive().optional(),
        measured_ree_kcal: z.number().positive().optional().describe("Indirect calorimetry result, preferred when available"),
        rq: z.object({ vo2: z.number().positive(), vco2: z.number().positive() }).optional(),
        bmi_for_age_percentile: z.number().min(0).max(100).optional(),
        activity_factor: z.string().optional().describe("minimal | moderate | strenuous"),
        activity_position: z.union([z.enum(["low", "mid", "high"]), z.number().min(0).max(1)]).optional(),
        pal: z.number().positive().optional(),
        pal_category: z.enum(["sedentary", "low_active", "active", "very_active"]).optional(),
        activities: z
          .array(z.object({ id: z.string().optional(), delta_pal_per_hour: z.number().optional(), hours: z.number().optional(), minutes: z.number().optional() }))
          .optional(),
        stress: z.array(z.object({ id: z.string() }).passthrough()).optional().describe("e.g. [{id:'fever', ...params}]"),
        pregnancy: z.object({ trimester: z.number().int().min(1).max(3) }).optional(),
        lactation: z.object({ months_postpartum: z.number().nonnegative() }).optional(),
        prefer: z.enum(["iom", "ree"]).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safeTool("energy_requirements", async (input) => {
      if (input.age_years === undefined && input.age_months === undefined) throw new Error("Provide age_years or age_months.");
      const res = await chakudyaClient.post("/energy/requirements", input);
      return ok(res.data ?? res, { disclaimer: "Estimate only. Confirm with clinical judgement or indirect calorimetry." });
    })
  );

  server.registerTool(
    "food_energy_calculate",
    {
      title: "Food Energy from Macronutrients (Atwater)",
      description:
        "Compute kcal/kJ and the macronutrient energy split from grams of protein, fat, carbohydrate and alcohol, or from a weight " +
        "and percent composition, optionally with an alcoholic drink (volume in US oz plus proof or abv_percent). Uses 4/9/4/7 kcal per g.",
      inputSchema: {
        protein_g: z.number().nonnegative().optional(),
        fat_g: z.number().nonnegative().optional(),
        carbohydrate_g: z.number().nonnegative().optional(),
        alcohol_g: z.number().nonnegative().optional(),
        fiber_g: z.number().nonnegative().optional().describe("Informational, not added"),
        weight_g: z.number().positive().optional(),
        protein_pct: z.number().min(0).max(100).optional(),
        fat_pct: z.number().min(0).max(100).optional(),
        carbohydrate_pct: z.number().min(0).max(100).optional(),
        alcohol_pct: z.number().min(0).max(100).optional(),
        alcohol: z
          .object({ volume_oz: z.number().positive(), proof: z.number().positive().optional(), abv_percent: z.number().positive().optional() })
          .optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safeTool("food_energy_calculate", async (input) => {
      const res = await chakudyaClient.post("/energy/food-energy", input);
      return ok(res.data ?? res);
    })
  );

  server.registerTool(
    "activity_energy_list",
    {
      title: "Physical Activity Energy Table (kcal per hour)",
      description:
        "Browse the physical-activity energy table (Krause Appendix 10). Filter by q or activity; give weight_kg to get kcal per hour " +
        "for that body weight, otherwise the printed weight columns (110-250 lb) are returned.",
      inputSchema: {
        q: z.string().optional(),
        activity: z.string().optional(),
        weight_kg: z.number().positive().optional(),
      },
      annotations: READ,
    },
    safeTool("activity_energy_list", async ({ q, activity, weight_kg }) => {
      const res = await chakudyaClient.get("/activity-energy", { q, activity, weight_kg });
      return ok(res.data ?? res, { count: res.count });
    })
  );

  server.registerTool(
    "activity_energy_calculate",
    {
      title: "Energy Spent on a List of Activities",
      description:
        "Estimate total kcal for a day's activities at the person's body weight (interpolated from the Krause table; flagged outside 110-250 lb). " +
        "Each activity has a name (from activity_energy_list), optional type, and minutes or hours.",
      inputSchema: {
        weight_kg: z.number().min(20).max(250),
        activities: z
          .array(
            z.object({
              activity: z.string().min(1),
              type: z.string().optional(),
              minutes: z.number().positive().optional(),
              hours: z.number().positive().optional(),
            })
          )
          .min(1),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safeTool("activity_energy_calculate", async (input) => {
      for (const a of input.activities) {
        if (a.minutes === undefined && a.hours === undefined) throw new Error(`Activity '${a.activity}' needs minutes or hours.`);
      }
      const res = await chakudyaClient.post("/activity-energy/calculate", input);
      return ok(res.data ?? res);
    })
  );
}
