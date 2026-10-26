import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { chakudyaClient } from "../clients/chakudyaClient.js";
import { safeTool } from "../utils/toolResult.js";
import { okWithApiMeta } from "../utils/apiMeta.js";

/**
 * Harris-Benedict predictive energy equation, Barak et al (2002) clinical
 * stress factor table, and the accompanying 24-hour energy expenditure
 * adjustment factors (ventilation, body temperature, sedation, activity),
 * as compiled in a hospital dietetics "Predictive energy equations"
 * reference sheet (section 1.2).
 *
 * Three tools:
 *   - harris_benedict_bee_calculator
 *   - stress_factor_reference (Barak et al, 2002)
 *   - twenty_four_hour_energy_adjustment_reference
 *
 * The logic and every coefficient, factor and text now live in chakudya-api
 * (src/stressFactors.js, /stress-factors/*), with the values read from the
 * clinical_reference_values table (condition 'stress_factors'), so the API is
 * the single source of truth and values can be corrected in Supabase without
 * redeploying this server. These tools only pass the inputs through.
 *
 * Reference/estimate only, not a substitute for individualized clinical
 * assessment; indirect calorimetry is preferred where available.
 */

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

export function registerHarrisBenedictStressFactorTools(server: McpServer) {
  // ── harris_benedict_bee_calculator ────────────────────────────────────────
  server.registerTool(
    "harris_benedict_bee_calculator",
    {
      title: "Harris-Benedict BEE Calculator",
      description:
        "Compute Basal Energy Expenditure (BEE) via the Harris-Benedict equation: " +
        "Males = 66.5 + 13.8(Wt kg) + 5.0(Ht cm) - 6.8(Age); " +
        "Females = 655.1 + 9.6(Wt kg) + 1.9(Ht cm) - 4.7(Age). " +
        "Optionally apply a stress factor (see stress_factor_reference) and/or 24-hour adjustment factors " +
        "(see twenty_four_hour_energy_adjustment_reference) to the BEE in the same call. If more than one " +
        "stress factor would apply clinically, pass only the single highest one, per source, do not stack them.",
      inputSchema: {
        sex: z.enum(["male", "female"]),
        weight_kg: z.number().positive(),
        height_cm: z.number().positive(),
        age_years: z.number().positive(),
        stress_factor: z
          .number()
          .positive()
          .optional()
          .describe("Optional single stress factor to multiply BEE by (use the highest applicable one only)."),
        adjustment_factor: z
          .number()
          .positive()
          .optional()
          .describe("Optional additional 24-hour adjustment factor (ventilation, sedation, activity) to multiply by."),
        body_temp_c: z
          .number()
          .optional()
          .describe("Optional body temperature in °C; applies ±13% per °C above/below 37°C to the running total."),
      },
      annotations: READ,
    },
    safeTool("harris_benedict_bee_calculator", async (input) => {
      const res = await chakudyaClient.post("/stress-factors/harris-benedict", input);
      return okWithApiMeta(res);
    })
  );

  // ── stress_factor_reference ───────────────────────────────────────────────
  server.registerTool(
    "stress_factor_reference",
    {
      title: "Stress Factor Reference (Barak et al, 2002)",
      description:
        "Look up clinical stress factors to multiply against BEE (e.g. from harris_benedict_bee_calculator), " +
        "per Barak et al (2002). Covers starvation/refeeding, post-op, surgery, organ transplant, IBD, " +
        "fracture, sepsis/infection, peritonitis, multiple trauma, respiratory failure/COPD, active TB, " +
        "acute/chronic/septic pancreatitis, TBI/closed head injury, acute spinal cord injury, ICU sepsis, " +
        "CVA, leukaemia, lymphoma, solid tumours, liver disease, and wound healing. If more than one " +
        "condition applies, per source use only the single HIGHEST stress factor, not the sum or product " +
        "of several. Provide a condition_key to look up one row, or omit it to return the full table (the " +
        "keys are in the full table).",
      inputSchema: {
        condition_key: z
          .string()
          .optional()
          .describe("Optional key for a single condition, e.g. 'wound_healing'. Omit to return the full table."),
      },
      annotations: READ,
    },
    safeTool("stress_factor_reference", async ({ condition_key }) => {
      const res = await chakudyaClient.get("/stress-factors/conditions", { condition_key });
      return okWithApiMeta(res);
    })
  );

  // ── twenty_four_hour_energy_adjustment_reference ──────────────────────────
  server.registerTool(
    "twenty_four_hour_energy_adjustment_reference",
    {
      title: "24-Hour Energy Expenditure Adjustment Reference",
      description:
        "Look up the 24-hour energy expenditure adjustment factors that accompany the Harris-Benedict/stress " +
        "factor calculation: ventilation (0.95), body temperature (±13% per °C above/below 37°C), " +
        "sedatives/paralytics/barbiturates (0.75-1.00), activity while bedridden and awake (1.1-1.2), and " +
        "activity while very restless (1.2-1.45). Always multiply these factors with BEE (or with " +
        "BEE x stress factor, if a stress factor also applies).",
      inputSchema: {},
      annotations: READ,
    },
    safeTool("twenty_four_hour_energy_adjustment_reference", async () => {
      const res = await chakudyaClient.get("/stress-factors/adjustments");
      return okWithApiMeta(res);
    })
  );
}
