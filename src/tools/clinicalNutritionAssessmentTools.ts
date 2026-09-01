import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, safeTool } from "../utils/toolResult.js";

/**
 * Clinical Nutrition Assessment — general ADIME-format documentation
 * template (unattributed hospital/training template; the Nutrition Status
 * checklist on it corresponds to the published AND/ASPEN 2012 consensus
 * malnutrition characteristics: White JV, Guenter P, Jensen G, et al.
 * Consensus statement of the Academy of Nutrition and Dietetics/American
 * Society for Parenteral and Enteral Nutrition: characteristics
 * recommended for the identification and documentation of adult
 * malnutrition (undernutrition). JPEN J Parenter Enteral Nutr.
 * 2012;36(3):275-283.
 *
 * Two tools:
 * - nutrition_status_classification — classify nutrition status against
 *   the template's checklist categories (adequately nourished / at risk /
 *   starvation-related / chronic disease-related / acute disease-related
 *   malnutrition), including the "no nutrition x days" and "<X% of needs
 *   x days" inadequate-intake triggers. This is an ETIOLOGY-based
 *   categorization (the AND/ASPEN 2012 framework) — distinct from the
 *   GLIM tools already in this set, which combine phenotypic AND etiologic
 *   criteria into a separate 2019 consensus framework. The two frameworks
 *   are related but not identical and can disagree; this tool doesn't
 *   attempt to reconcile them.
 * - percent_usual_body_weight — %UBW = (current weight / usual weight) x
 *   100, a plain unambiguous calculation the template has fields for but
 *   no worked formula.
 *
 * Pure classification/calculation — no Chakudya API calls. Educational/
 * clinical-support only, not a substitute for full clinical assessment.
 */

const CNA_DISCLAIMER =
  "Educational/clinical-support tool only. Nutrition status categories correspond to the published " +
  "AND/ASPEN 2012 consensus characteristics for identifying and documenting adult malnutrition " +
  "(White et al, JPEN 2012;36(3):275-283) — a distinct etiology-based framework from the GLIM tools " +
  "elsewhere in this tool set. Not a substitute for a full clinical nutrition assessment.";

export function registerClinicalNutritionAssessmentTools(server: McpServer): void {
  // ── Nutrition status classification ──────────────────────────────────────
  server.registerTool(
    "nutrition_status_classification",
    {
      title: "Nutrition Status Classification (AND/ASPEN Etiology Categories)",
      description:
        "Classify nutrition status against the AND/ASPEN 2012 consensus etiology categories: " +
        "adequately nourished, at risk for malnutrition, starvation-related malnutrition (chronic " +
        "starvation without inflammation), chronic disease-related malnutrition (sustained mild-to- " +
        "moderate inflammation), or acute disease-related malnutrition (severe inflammatory response, " +
        "e.g. major infection/burns/trauma). Also flags the two inadequate-intake triggers commonly " +
        "used to support a malnutrition diagnosis: no nutrition for a specified number of days, or " +
        "intake below a specified percent of estimated needs for a specified number of days.",
      inputSchema: {
        has_inflammation_or_disease_process: z
          .boolean()
          .optional()
          .describe("Whether there is an active disease/inflammatory process driving nutritional risk"),
        inflammation_severity: z
          .enum(["none", "mild_to_moderate_chronic", "severe_acute"])
          .optional()
          .describe(
            "None: pure starvation/inadequate intake without disease. Mild-to-moderate chronic: " +
              "sustained low-grade inflammation (e.g. organ failure, cancer, rheumatoid arthritis, " +
              "sarcopenic obesity) -> chronic disease-related. Severe acute: major infection, burns, " +
              "trauma, closed head injury -> acute disease-related."
          ),
        at_nutritional_risk: z
          .boolean()
          .optional()
          .describe("Whether the patient shows some risk factors but doesn't yet meet a malnutrition category"),
        no_nutrition_days: z.number().min(0).optional().describe("Number of days with no nutritional intake, if applicable"),
        inadequate_intake_percent_of_needs: z
          .number()
          .min(0)
          .max(100)
          .optional()
          .describe("Percent of estimated needs actually being met, if intake has been inadequate"),
        inadequate_intake_days: z.number().min(0).optional().describe("Number of days at that inadequate intake level"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool(
      "nutrition_status_classification",
      async ({
        has_inflammation_or_disease_process,
        inflammation_severity,
        at_nutritional_risk,
        no_nutrition_days,
        inadequate_intake_percent_of_needs,
        inadequate_intake_days,
      }) => {
        let category: string;
        let basis: string;

        if (inflammation_severity === "severe_acute" || (has_inflammation_or_disease_process && inflammation_severity === undefined && has_inflammation_or_disease_process)) {
          category = inflammation_severity === "severe_acute" ? "acute_disease_related_malnutrition" : "disease_related_malnutrition (severity unspecified)";
          basis = "Active disease process with severe acute inflammatory response (e.g. major infection, burns, trauma).";
        } else if (inflammation_severity === "mild_to_moderate_chronic") {
          category = "chronic_disease_related_malnutrition";
          basis = "Sustained mild-to-moderate chronic inflammation from an underlying disease process.";
        } else if (inflammation_severity === "none" || has_inflammation_or_disease_process === false) {
          category = "starvation_related_malnutrition";
          basis = "Chronic inadequate intake without an active inflammatory disease process (pure or social/environmental starvation).";
        } else if (at_nutritional_risk) {
          category = "at_risk_for_malnutrition";
          basis = "Risk factors present but does not yet meet a malnutrition category.";
        } else {
          category = "adequately_nourished";
          basis = "No indicators of inadequate intake, inflammation, or nutritional risk provided.";
        }

        const flags: string[] = [];
        if (no_nutrition_days !== undefined && no_nutrition_days > 0) {
          flags.push(`No nutrition for ${no_nutrition_days} day(s)`);
        }
        if (inadequate_intake_percent_of_needs !== undefined && inadequate_intake_days !== undefined) {
          flags.push(`Intake <${inadequate_intake_percent_of_needs}% of estimated needs for ${inadequate_intake_days} day(s)`);
        }

        return ok(
          {
            category,
            basis,
            inadequate_intake_flags: flags,
            note:
              "This is the etiology-based AND/ASPEN 2012 framework, not the GLIM 2019 framework used " +
              "elsewhere in this tool set (glim_malnutrition_diagnosis / glim_etiology_classification). " +
              "The two frameworks are related but distinct and can produce different categorizations " +
              "for the same patient — check both if reconciling for a specific documentation requirement.",
          },
          { disclaimer: CNA_DISCLAIMER, citation: "White et al, JPEN J Parenter Enteral Nutr 2012;36(3):275-283 (AND/ASPEN consensus)" }
        );
      }
    )
  );

  // ── %UBW ──────────────────────────────────────────────────────────────────
  server.registerTool(
    "percent_usual_body_weight",
    {
      title: "Percent Usual Body Weight (%UBW)",
      description: "Calculate %UBW = (current weight / usual weight) x 100. A standard anthropometric field in nutrition assessment documentation.",
      inputSchema: {
        current_weight_kg: z.number().positive(),
        usual_weight_kg: z.number().positive(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("percent_usual_body_weight", async ({ current_weight_kg, usual_weight_kg }) => {
      const percentUbw = (current_weight_kg / usual_weight_kg) * 100;
      return ok(
        {
          percent_usual_body_weight: Math.round(percentUbw * 10) / 10,
          weight_change_kg: Math.round((current_weight_kg - usual_weight_kg) * 10) / 10,
          formula: "%UBW = (current weight / usual weight) x 100",
        },
        { disclaimer: CNA_DISCLAIMER }
      );
    })
  );
}
