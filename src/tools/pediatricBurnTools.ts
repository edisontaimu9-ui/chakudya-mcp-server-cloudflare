import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { chakudyaClient } from "../clients/chakudyaClient.js";
import { safeTool } from "../utils/toolResult.js";
import { okWithApiMeta } from "../utils/apiMeta.js";

/**
 * Nutrition in Pediatric Burns, on chakudya-api (/burns/*).
 *
 * Source: Mrazek AA, Simpson P, Lee JO. Nutrition in Pediatric Burns. Semin Plast Surg.
 * 2024;38:125-132. DOI: 10.1055/s-0044-1782648.
 *
 * The formulas live in the API (src/burnNutrition.js) and every coefficient, band, dose and
 * reference text is read there from the clinical_reference_values table; these tools only pass the
 * inputs through. Educational/clinical-support only, not a substitute for individualized clinical
 * assessment or current prescribing information.
 *
 * Tools:
 *   - burn_pediatric_maintenance_fluid_holliday_segar        POST /burns/maintenance-fluid
 *       (daily MAINTENANCE fluid; distinct from burn_fluid_resuscitation_parkland, which is acute
 *       RESUSCITATION fluid for burns >10% TBSA)
 *   - burn_indirect_calorimetry_ree                          POST /burns/indirect-calorimetry
 *   - burn_pediatric_predictive_equations_comparison         POST /burns/pediatric-equations
 *       (Table 1's equation families side by side; the weight-only Schofield here differs from the
 *       adult tool's source, so they will not agree. Deliberately not collapsed to one answer)
 *   - burn_hypermetabolism_pharmacologic_dosing              POST /burns/pharmacology
 *       (includes the FDA oxandrolone withdrawal, 23 June 2023, flagged in the result)
 */

export function registerPediatricBurnTools(server: McpServer): void {
  // ── Maintenance fluid (Holliday-Segar) ───────────────────────────────────
  server.registerTool(
    "burn_pediatric_maintenance_fluid_holliday_segar",
    {
      title: "Pediatric Maintenance Fluid — Holliday-Segar Method",
      description:
        "Estimate daily MAINTENANCE fluid requirement (not acute burn resuscitation fluid) using the " +
        "Holliday-Segar method: 1-10kg = 100 mL/kg; 11-20kg = 1000 mL + 50 mL/kg for each kg over 10; " +
        ">20kg = 1500 mL + 20 mL/kg for each kg over 20. For acute resuscitation of burns >10% TBSA, " +
        "use burn_fluid_resuscitation_parkland instead — these are two different clinical purposes.",
      inputSchema: {
        weight_kg: z.number().positive(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safeTool("burn_pediatric_maintenance_fluid_holliday_segar", async (input) => {
      const res = await chakudyaClient.post("/burns/maintenance-fluid", input);
      return okWithApiMeta(res);
    })
  );

  // ── Indirect calorimetry REE (Weir equation) ─────────────────────────────
  server.registerTool(
    "burn_indirect_calorimetry_ree",
    {
      title: "Resting Energy Expenditure from Indirect Calorimetry (Weir Equation)",
      description:
        "Convert measured VO2 and VCO2 (from a metabolic cart) into REE using the modified Weir " +
        "equation: REE (kcal/day) = 1.44 x (3.9 x VO2[mL/min] + 1.1 x VCO2[mL/min]). Optionally applies " +
        "a 1.4x activity factor (meets needs of 95% of burn patients per source) and/or a daytime " +
        "variability adjustment (10-20%, since measurements are typically taken overnight at rest). " +
        "Indirect calorimetry is the gold-standard measurement this source recommends over any " +
        "predictive equation.",
      inputSchema: {
        vo2_ml_per_min: z.number().positive().describe("Oxygen consumed, mL/min"),
        vco2_ml_per_min: z.number().positive().describe("Carbon dioxide produced, mL/min"),
        apply_activity_factor: z
          .boolean()
          .optional()
          .describe("If true, also returns REE x 1.4 (total energy expenditure estimate meeting 95% of burn patients' needs)"),
        daytime_variability_percent: z
          .number()
          .min(10)
          .max(20)
          .optional()
          .describe("If given (10-20), also returns REE increased by this percent to account for daytime activity, since measurement is typically taken overnight at rest"),
        tbsa_burned_percent: z
          .number()
          .min(0)
          .max(100)
          .optional()
          .describe("Optional — used only to attach the source's TBSA/REE context note, not in the calculation itself"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safeTool("burn_indirect_calorimetry_ree", async (input) => {
      const res = await chakudyaClient.post("/burns/indirect-calorimetry", input);
      return okWithApiMeta(res);
    })
  );

  // ── Pediatric predictive equations comparison ────────────────────────────
  server.registerTool(
    "burn_pediatric_predictive_equations_comparison",
    {
      title: "Pediatric Burn Predictive BMR Equations — Side-by-Side Comparison",
      description:
        "Returns every applicable equation from Table 1 (Curreri Junior, Galveston, Mayes, Schofield " +
        "[weight-only pediatric version], WHO) for the given age/sex/weight, side by side rather than " +
        "picking one. The source's own point: all of these have historically OVERPREDICTED BMR, leading " +
        "to overfeeding and complications (hyperglycemia, hepatosteatosis, ventilator dependence from " +
        "hypercapnia) — measured REE via indirect calorimetry is recommended over any of them. NOTE: " +
        "the Schofield formula here is weight-only and differs from the weight+height Schofield equations " +
        "in burn_energy_requirements (a different published source/variant) — they will not agree.",
      inputSchema: {
        sex: z.enum(["male", "female"]),
        age_years: z.number().min(0),
        weight_kg: z.number().positive(),
        tbsa_burned_percent: z
          .number()
          .min(0)
          .max(100)
          .optional()
          .describe("Required for Curreri Junior, Galveston, and Mayes (burn-specific formulas); not needed for Schofield/WHO (general basal equations)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safeTool("burn_pediatric_predictive_equations_comparison", async (input) => {
      const res = await chakudyaClient.post("/burns/pediatric-equations", input);
      return okWithApiMeta(res);
    })
  );

  // ── Hypermetabolism pharmacologic dosing ─────────────────────────────────
  server.registerTool(
    "burn_hypermetabolism_pharmacologic_dosing",
    {
      title: "Burn Hypermetabolism Pharmacologic Agents — Dosing Reference",
      description:
        "Dosing reference for the anabolic/catabolic-antagonist agents used to modulate the hypermetabolic " +
        "response in pediatric burns: growth hormone, IGF-1/IGFBP-3, insulin, propranolol, and " +
        "oxandrolone. IMPORTANT: includes a regulatory safety flag for oxandrolone (FDA withdrew approval " +
        "June 23, 2023) not present in older sources.",
      inputSchema: {
        weight_kg: z.number().positive().optional().describe("If given, scales weight-based doses to this patient"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safeTool("burn_hypermetabolism_pharmacologic_dosing", async (input) => {
      const res = await chakudyaClient.post("/burns/pharmacology", input);
      return okWithApiMeta(res);
    })
  );
}
