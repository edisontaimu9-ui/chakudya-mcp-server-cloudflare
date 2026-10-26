import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { chakudyaClient } from "../clients/chakudyaClient.js";
import { safeTool } from "../utils/toolResult.js";
import { okWithApiMeta } from "../utils/apiMeta.js";

/**
 * Medical Nutrition Therapy in Burns, on chakudya-api (/burns/*).
 *
 * Source: Abillama F. Medical Nutrition Therapy in Burns: Optimizing Healing and Recovery. LAUMCRH
 * Beirut Lebanon (teaching deck citing ESPEN endorsed recommendations, Rousseau et al, Clin Nutr
 * 2013;32:497-502, and others noted in each result's citation).
 *
 * The formulas live in the API (src/burnNutrition.js) and every coefficient, band, dose and
 * reference text is read there from the clinical_reference_values table, so the API is the single
 * source of truth and values can be corrected in Supabase without redeploying this server. These
 * tools only pass the inputs through.
 *
 * Tools:
 *   - burn_fluid_resuscitation_parkland   POST /burns/fluid-resuscitation
 *   - burn_energy_requirements            POST /burns/energy
 *   - burn_protein_requirements           POST /burns/protein
 *   - burn_nitrogen_balance               POST /burns/nitrogen-balance
 *   - burn_micronutrient_dosing           POST /burns/micronutrients
 *   - burn_glucose_glycemic_targets       POST /burns/glycemic-targets
 *
 * Per the deck itself: "NO predictive equation is accurate." Indirect calorimetry is the gold
 * standard; these are fallbacks. Calculators/classifiers only, not a substitute for clinical judgment.
 */

export function registerBurnNutritionTools(server: McpServer): void {
  // ── Fluid resuscitation (Parkland/Baxter formula) ────────────────────────
  server.registerTool(
    "burn_fluid_resuscitation_parkland",
    {
      title: "Burn Fluid Resuscitation — Parkland (Baxter) Formula",
      description:
        "Calculate 24-hour crystalloid resuscitation volume for burns covering >10% TBSA using the " +
        "Parkland (Baxter, 1974) formula: 4 mL x weight(kg) x %TBSA burned. Half is given in the first " +
        "8 hours from the time of injury (not from time of arrival), the remaining half over the next " +
        "16 hours.",
      inputSchema: {
        weight_kg: z.number().positive(),
        tbsa_burned_percent: z
          .number()
          .min(0)
          .max(100)
          .describe("Total body surface area burned, percent. Formula is indicated for >10% TBSA."),
        hours_since_burn: z
          .number()
          .min(0)
          .optional()
          .describe("Hours elapsed since the burn injury (not since hospital arrival), if known"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safeTool("burn_fluid_resuscitation_parkland", async (input) => {
      const res = await chakudyaClient.post("/burns/fluid-resuscitation", input);
      return okWithApiMeta(res);
    })
  );

  // ── Energy requirements (Toronto / Schofield) ────────────────────────────
  server.registerTool(
    "burn_energy_requirements",
    {
      title: "Burn Energy Requirements — Toronto (adult) / Schofield (pediatric)",
      description:
        "Estimate resting energy expenditure (REE) for a burn patient. Adults (>=18y): Toronto equation " +
        "(requires a Harris-Benedict basal value, computed internally with no stress/activity factors, " +
        "per the source). Children (all pediatric ages): weight-only Schofield equation (Mrazek et al " +
        "Indirect calorimetry remains the gold standard when available; this is a fallback estimate.",
      inputSchema: {
        weight_kg: z.number().positive(),
        height_cm: z.number().positive(),
        age_years: z.number().min(0),
        sex: z.enum(["male", "female"]),
        tbsa_burned_percent: z.number().min(0).max(100).optional().describe("Required for adults (Toronto)"),
        kcal_intake_past_24h: z
          .number()
          .min(0)
          .optional()
          .describe("Required for adults (Toronto): calorie intake in the past 24 hours"),
        body_temp_c: z.number().optional().describe("Required for adults (Toronto): body temperature, Celsius"),
        days_post_burn: z
          .number()
          .min(0)
          .optional()
          .describe("Required for adults (Toronto): days since burn injury, injury day = 0"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safeTool("burn_energy_requirements", async (input) => {
      const res = await chakudyaClient.post("/burns/energy", input);
      return okWithApiMeta(res);
    })
  );

  // ── Protein requirements ─────────────────────────────────────────────────
  server.registerTool(
    "burn_protein_requirements",
    {
      title: "Burn Protein Requirements",
      description:
        "Estimate protein needs (g/kg/day) and the target non-protein-calorie:nitrogen (NPC:N) ratio " +
        "by burn size, per ESPEN endorsed recommendations (Rousseau et al 2013, Table 1). Burn patients " +
        "need substantially higher protein than other critically ill patients: adults 1.5-2 g/kg/day, " +
        "children 1.5-3 g/kg/day. Note: adult intakes above 2.2 g/kg/day show no further benefit on net " +
        "protein synthesis (Wolfe et al, Adv Shock Res 1983), and pediatric intakes up to 3 g/kg/day " +
        "showed no added advantage over lower doses (O'Neil et al, J Burn Care Rehabil 1989).",
      inputSchema: {
        tbsa_burned_percent: z.number().min(0).max(100),
        weight_kg: z.number().positive().optional().describe("If given, also returns total grams/day"),
        is_pediatric: z.boolean().optional().describe("If true, uses the pediatric 1.5-3 g/kg/day range"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safeTool("burn_protein_requirements", async (input) => {
      const res = await chakudyaClient.post("/burns/protein", input);
      return okWithApiMeta(res);
    })
  );

  // ── Nitrogen balance ──────────────────────────────────────────────────────
  server.registerTool(
    "burn_nitrogen_balance",
    {
      title: "Burn Nitrogen Balance",
      description:
        "Calculate nitrogen balance (Nitrogen Balance = protein_intake_g/6.25 - UUN/0.8 + 4) and, if " +
        "percent open wound is given, add the Gottschlich (1993) estimated nitrogen loss through burned " +
        "tissue: <10% open = 0.02 g N/kg/day, 11-30% = 0.05 g N/kg/day, >31% = 0.12 g N/kg/day. Nitrogen " +
        "losses should begin to decrease as wounds heal or engraft.",
      inputSchema: {
        protein_intake_g: z.number().min(0).describe("24-hour protein intake, grams"),
        uun_g: z.number().min(0).describe("24-hour urine urea nitrogen (UUN), grams"),
        open_wound_percent: z.number().min(0).max(100).optional(),
        weight_kg: z.number().positive().optional().describe("Required for the burned-tissue N-loss estimate"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safeTool("burn_nitrogen_balance", async (input) => {
      const res = await chakudyaClient.post("/burns/nitrogen-balance", input);
      return okWithApiMeta(res);
    })
  );

  // ── Micronutrient dosing guidance ────────────────────────────────────────
  server.registerTool(
    "burn_micronutrient_dosing",
    {
      title: "Burn Micronutrient Dosing Guidance",
      description:
        "Vitamin and trace-element dosing guidance for burn patients by burn size, per ESPEN endorsed " +
        "recommendations plus the case-study/cohort sources cited in the deck. Note: albumin, " +
        "prealbumin, and transferrin are NOT useful for assessing protein intake in burn patients " +
        "(affected by hydration, inflammation, hypermetabolism).",
      inputSchema: {
        tbsa_burned_percent: z.number().min(0).max(100),
        bmi: z.number().positive().optional().describe("Used for the Vitamin A dose-halving criterion"),
        age_years: z.number().min(0).optional().describe("Used for the Vitamin A dose-halving criterion"),
        chronically_malnourished: z.boolean().optional().describe("Used for the Vitamin A dose-halving criterion"),
        open_wound_percent: z.number().min(0).max(100).optional().describe("Used to flag Vitamin A discontinuation threshold"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safeTool("burn_micronutrient_dosing", async (input) => {
      const res = await chakudyaClient.post("/burns/micronutrients", input);
      return okWithApiMeta(res);
    })
  );

  // ── Carbohydrate delivery and glycemic targets ───────────────────────────
  server.registerTool(
    "burn_glucose_glycemic_targets",
    {
      title: "Burn Carbohydrate Delivery & Glycemic Targets",
      description:
        "Carbohydrate delivery limit and blood glucose targets for burn patients, per ESPEN endorsed " +
        "recommendations (strong recommendation, Rousseau et al 2013, Table 1): limit carbohydrate " +
        "delivery to 55-60% of total energy intake and not exceeding 5 mg/kg/min in both adults and " +
        "children (~7 g/kg/day in a standard adult), and keep blood glucose between 5-8 mmol/l via " +
        "continuous IV insulin infusion.",
      inputSchema: {
        weight_kg: z.number().positive().optional().describe("If given, computes the max carbohydrate g/day ceiling"),
        total_energy_kcal_per_day: z
          .number()
          .positive()
          .optional()
          .describe("If given, computes the carbohydrate kcal/day range at 55-60% of total energy"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safeTool("burn_glucose_glycemic_targets", async (input) => {
      const res = await chakudyaClient.post("/burns/glycemic-targets", input);
      return okWithApiMeta(res);
    })
  );
}
