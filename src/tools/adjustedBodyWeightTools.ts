import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, safeTool } from "../utils/toolResult.js";

/**
 * Guidelines for the Calculation of Nutrition Requirements — weight
 * selection and Adjusted Body Weight (AdjBW) guidance for surgical
 * patients (hospital clinical guideline; equations attributed to Glynn et
 * al 1999 and Barak et al 2002).
 *
 * Two tools:
 * - nutrition_requirement_weight_selection — guidance on which weight to
 *   use for energy/protein calculations given edema, extreme
 *   underweight, or obesity.
 * - adjusted_body_weight_calculator — [(Actual - Ideal) x factor] + Ideal,
 *   using either the 25% factor (Glynn et al 1999, more commonly used in
 *   practice) or the 50% factor (Barak et al 2002).
 *
 * NOTE: this source references Ideal Body Weight (IBW) but does not state
 * which IBW formula to use (e.g. Devine, Hamwi) — ideal_body_weight_kg is
 * therefore a required input here rather than computed internally, to
 * avoid introducing a formula this source doesn't actually specify. Supply
 * IBW from whatever formula your institution's protocol specifies.
 *
 * Pure guidance/calculation — no Chakudya API calls. Educational/clinical-
 * support only, not a substitute for individualized clinical assessment.
 */

const ABW_DISCLAIMER =
  "Educational/clinical-support tool only, per hospital clinical guideline 'Guidelines for the " +
  "Calculation of Nutrition Requirements' (Adjusted Body Weight equations: Glynn et al, 1999; Barak " +
  "et al, 2002). Requires an externally supplied Ideal Body Weight, as this source does not specify " +
  "which IBW formula to use. Not a substitute for individualized clinical assessment.";

export function registerAdjustedBodyWeightTools(server: McpServer): void {
  // ── Weight selection guidance ─────────────────────────────────────────────
  server.registerTool(
    "nutrition_requirement_weight_selection",
    {
      title: "Which Weight to Use for Nutrition Requirement Calculations",
      description:
        "Guidance on which weight to use for calculating energy and protein requirements. Default: " +
        "actual weight. Adjust when the patient is edematous, extremely underweight (BMI <15 kg/m2 — " +
        "start with actual weight, adjust upward for weight gain as feeding progresses; avoid Ideal " +
        "Body Weight, which risks overfeeding), or obese (actual weight risks overfeeding — consider " +
        "an Adjusted Body Weight equation instead).",
      inputSchema: {
        bmi: z.number().positive().optional(),
        is_edematous: z.boolean().optional(),
        is_obese: z.boolean().optional().describe("As clinically determined — this source doesn't specify a numeric BMI cutoff for obesity"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("nutrition_requirement_weight_selection", async ({ bmi, is_edematous, is_obese }) => {
      const recommendations: string[] = [];

      if (is_edematous) {
        recommendations.push(
          "Patient is edematous: weight should be adjusted for excess fluid — actual (fluid-inflated) weight will overestimate requirements. Consult your institution's edema/dry-weight adjustment protocol (this source references an appendix not included here)."
        );
      }

      if (bmi !== undefined && bmi < 15) {
        recommendations.push(
          "BMI <15 kg/m2 (extremely underweight): always start with actual weight. Adjust for weight gain as feeding progresses. Avoid using Ideal Body Weight here — it may result in overfeeding."
        );
      }

      if (is_obese) {
        recommendations.push(
          "Obese: using actual weight will result in overfeeding. Consider an Adjusted Body Weight equation (see adjusted_body_weight_calculator) instead."
        );
      }

      if (recommendations.length === 0) {
        recommendations.push("No adjustment situations flagged — use the patient's actual weight for calculating energy and protein requirements.");
      }

      return ok(
        {
          default_weight_basis: "actual body weight",
          recommendations,
        },
        { disclaimer: ABW_DISCLAIMER }
      );
    })
  );

  // ── Adjusted Body Weight calculator ──────────────────────────────────────
  server.registerTool(
    "adjusted_body_weight_calculator",
    {
      title: "Adjusted Body Weight (AdjBW) Calculator",
      description:
        "Calculate Adjusted Body Weight for surgical patients: [(Actual Body Weight - Ideal Body " +
        "Weight) x factor] + Ideal Body Weight. Equation 'a' (25% factor, Glynn et al 1999) assumes " +
        "25% of the weight excess is metabolically active tissue and is used for significant " +
        "overfatness — this is the equation dietitians tend to use in practice. Equation 'b' (50% " +
        "factor, Barak et al 2002) assumes 50% of the weight excess is metabolically active tissue.",
      inputSchema: {
        actual_body_weight_kg: z.number().positive(),
        ideal_body_weight_kg: z.number().positive().describe("Supply from whatever IBW formula your institution's protocol specifies — not computed by this tool"),
        equation: z.enum(["a_25_percent_glynn_1999", "b_50_percent_barak_2002"]).optional().describe("Defaults to equation a (25%, Glynn 1999) — the more commonly used one in practice"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("adjusted_body_weight_calculator", async ({ actual_body_weight_kg, ideal_body_weight_kg, equation }) => {
      const eq = equation ?? "a_25_percent_glynn_1999";
      const factor = eq === "a_25_percent_glynn_1999" ? 0.25 : 0.5;
      const excess = actual_body_weight_kg - ideal_body_weight_kg;
      const adjBw = excess * factor + ideal_body_weight_kg;

      return ok(
        {
          adjusted_body_weight_kg: Math.round(adjBw * 10) / 10,
          equation_used: eq === "a_25_percent_glynn_1999" ? "Equation a (25%, Glynn et al 1999)" : "Equation b (50%, Barak et al 2002)",
          formula: `[(${actual_body_weight_kg} - ${ideal_body_weight_kg}) x ${factor}] + ${ideal_body_weight_kg}`,
          weight_excess_kg: Math.round(excess * 10) / 10,
          note: excess < 0 ? "Actual weight is below ideal — Adjusted Body Weight is intended for overfatness/obesity, not underweight patients. Reconsider whether this equation applies." : undefined,
        },
        {
          disclaimer: ABW_DISCLAIMER,
          citation: eq === "a_25_percent_glynn_1999" ? "Glynn et al, 1999" : "Barak et al, 2002",
        }
      );
    })
  );
}
