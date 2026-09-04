import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, safeTool } from "../utils/toolResult.js";

/**
 * Part B: Assessment of the Anthropometric Status of the Hospitalized
 * Patient — Sections 2.3-2.4 (adjusting body weight for amputation and for
 * oedema/ascites) and Section 3.1-3.3 (interpreting %IBW, %UBW, and percent
 * weight change), as compiled in a hospital dietetics anthropometry
 * guideline (Lee & Nieman; Width & Reinhard; Osterkamp 1995).
 *
 * Pure calculation / reference lookup — no Chakudya API calls.
 *
 * Tools:
 *   - amputation_weight_adjustment_calculator
 *   - oedema_ascites_weight_adjustment_reference
 *   - percent_ideal_body_weight_calculator
 *   - spinal_cord_injury_ibw_adjustment_reference
 *   - percent_weight_change_calculator
 *   - ibw_ubw_nutritional_risk_interpreter        (Width & Reinhard)
 *   - weight_change_significance_interpreter      (Width & Reinhard)
 */

const BWA_DISCLAIMER =
  "Estimate/reference only, from a hospital dietetics anthropometry guideline (citing Lee & Nieman; " +
  "Width & Reinhard; Osterkamp 1995). Not a substitute for individualized clinical assessment.";

function err(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

// ── 2.3 Amputations: % body weight contributed by body part ────────────────
// Three distinct source tables, reproduced separately rather than merged,
// since they don't fully agree with each other (different studies/labels).
const AMPUTATION_INDIVIDUAL_PARTS_LEE_NIEMAN: Record<string, number> = {
  "Entire arm": 6.5,
  "Upper arm": 3.5,
  Forearm: 2.3,
  Hand: 0.8,
  "Entire leg": 18.5,
  "Upper leg": 11.6,
  "Lower leg": 5.3,
  Foot: 1.8,
};

const AMPUTATION_TABLE_B: Record<string, number> = {
  "All four limbs": 50,
  "Entire leg": 16,
  Thigh: 10,
  "Lower leg with foot": 5.9,
  "Entire arm": 5,
  "Forearm with hand": 2.3,
  Foot: 1.5,
  Hand: 0.7,
};

const AMPUTATION_TABLE_C: Record<string, number> = {
  "Lower limb": 15.6,
  Thigh: 9.7,
  "Lower leg": 4.5,
  Foot: 1.4,
  "Upper limb": 4.9,
  "Upper arm": 2.7,
  Forearm: 1.6,
};

// ── 2.4 Oedema & Ascites weight adjustment ──────────────────────────────────
const OEDEMA_WEIGHT_ADJUSTMENT_KG: Record<string, number> = { mild: 1.0, moderate: 5.0, severe: 10.0 };
const ASCITES_WEIGHT_ADJUSTMENT_KG: Record<string, number> = { minimal: 2.2, moderate: 6.0, severe: 14.0 };

// ── 3.1/3.2 Width & Reinhard %IBW/%UBW nutritional risk interpretation ─────
interface IbwUbwRiskRow {
  percent_ibw_range: string;
  percent_ubw_range: string | null;
  nutritional_risk: string;
}
const IBW_UBW_RISK_TABLE: IbwUbwRiskRow[] = [
  { percent_ibw_range: "> 200", percent_ubw_range: null, nutritional_risk: "Morbid obese" },
  { percent_ibw_range: "> 120", percent_ubw_range: null, nutritional_risk: "Obese" },
  { percent_ibw_range: "110 - 120", percent_ubw_range: null, nutritional_risk: "Overweight" },
  { percent_ibw_range: "90 - 109", percent_ubw_range: null, nutritional_risk: "Not at risk" },
  { percent_ibw_range: "80 - 89", percent_ubw_range: "85 - 95", nutritional_risk: "Mild" },
  { percent_ibw_range: "70 - 79", percent_ubw_range: "75 - 84", nutritional_risk: "Moderate" },
  { percent_ibw_range: "< 70", percent_ubw_range: "< 75", nutritional_risk: "Severe" },
];

// ── 3.3 Width & Reinhard percent weight change interpretation ──────────────
interface WeightChangeRow {
  time_frame: string;
  significant_weight_loss: string;
  severe_weight_loss: string;
}
const WEIGHT_CHANGE_TABLE: WeightChangeRow[] = [
  { time_frame: "1 week", significant_weight_loss: "1% - 2%", severe_weight_loss: "> 2%" },
  { time_frame: "1 month", significant_weight_loss: "5%", severe_weight_loss: "> 5%" },
  { time_frame: "3 months", significant_weight_loss: "7.5%", severe_weight_loss: "> 7.5%" },
  { time_frame: "6 months", significant_weight_loss: "10%", severe_weight_loss: "> 10%" },
];

export function registerBodyWeightAdjustmentTools(server: McpServer) {
  // ── amputation_weight_adjustment_calculator ───────────────────────────────
  server.registerTool(
    "amputation_weight_adjustment_calculator",
    {
      title: "Amputation Weight Adjustment Calculator",
      description:
        "Look up the percentage of total body weight contributed by an amputated body part (from any of " +
        "three source tables — Lee & Nieman 'individual body parts', and two further body-part-lost tables), " +
        "and/or calculate adjusted body weight for an amputee: Adjusted Weight = [current weight / " +
        "(100 - %amputation)] x 100. Provide current_weight_kg and percent_amputation directly if you " +
        "already know the percentage, or provide body_part (matched against all three tables) to look up " +
        "the percentage and compute the adjustment in one call. Reference values are reproduced as three " +
        "separate source tables rather than merged, since they don't fully agree with each other.",
      inputSchema: {
        body_part: z
          .string()
          .optional()
          .describe(
            "Body part lost, e.g. 'Entire leg', 'Thigh', 'Forearm with hand', 'Lower limb', 'All four limbs'. Matched case-insensitively against all three source tables."
          ),
        percent_amputation: z
          .number()
          .positive()
          .max(100)
          .optional()
          .describe("Percent of total body weight the amputated part represents, if already known."),
        current_weight_kg: z.number().positive().optional().describe("Provide to also compute adjusted body weight."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("amputation_weight_adjustment_calculator", async ({ body_part, percent_amputation, current_weight_kg }) => {
      let resolvedPercent = percent_amputation;
      const matches: Array<{ table: string; body_part: string; percent: number }> = [];

      if (body_part !== undefined) {
        const lookupIn = (table: Record<string, number>, label: string) => {
          const key = Object.keys(table).find((k) => k.toLowerCase() === body_part.toLowerCase());
          if (key) matches.push({ table: label, body_part: key, percent: table[key] });
        };
        lookupIn(AMPUTATION_INDIVIDUAL_PARTS_LEE_NIEMAN, "Lee & Nieman individual body parts");
        lookupIn(AMPUTATION_TABLE_B, "Body part lost, table B");
        lookupIn(AMPUTATION_TABLE_C, "Body part lost, table C");

        if (matches.length === 0) {
          return err(
            `No match for body_part="${body_part}". Known parts: ${[
              ...new Set([
                ...Object.keys(AMPUTATION_INDIVIDUAL_PARTS_LEE_NIEMAN),
                ...Object.keys(AMPUTATION_TABLE_B),
                ...Object.keys(AMPUTATION_TABLE_C),
              ]),
            ].join(", ")}`
          );
        }
        if (resolvedPercent === undefined) resolvedPercent = matches[0].percent;
      }

      const result: Record<string, unknown> = { matches: matches.length > 0 ? matches : undefined };

      if (resolvedPercent !== undefined && current_weight_kg !== undefined) {
        const adjustedWeightKg = (current_weight_kg / (100 - resolvedPercent)) * 100;
        result.percent_amputation_used = resolvedPercent;
        result.current_weight_kg = current_weight_kg;
        result.adjusted_body_weight_kg = Math.round(adjustedWeightKg * 100) / 100;
        result.formula = "Adjusted Weight = [current weight / (100 - % amputation)] x 100";
      }

      if (Object.keys(result).length === 0 || (result.matches === undefined && resolvedPercent === undefined)) {
        return err("Provide either body_part, or percent_amputation (optionally with current_weight_kg).");
      }

      return ok(result, { disclaimer: BWA_DISCLAIMER, citation: "Lee & Nieman; Osterkamp, J Am Diet Assoc 1995;95(2):215-218" });
    })
  );

  // ── oedema_ascites_weight_adjustment_reference ────────────────────────────
  server.registerTool(
    "oedema_ascites_weight_adjustment_reference",
    {
      title: "Oedema/Ascites Weight Adjustment Reference",
      description:
        "Look up the estimated weight contribution of oedema (mild -1.0kg, moderate -5.0kg, severe " +
        "-10.0kg) and/or ascites (minimal -2.2kg, moderate -6.0kg, severe -14.0kg) to subtract from " +
        "current weight to estimate dry weight. Provide current_weight_kg to also compute the adjusted " +
        "(dry) weight.",
      inputSchema: {
        oedema_severity: z.enum(["mild", "moderate", "severe"]).optional(),
        ascites_severity: z.enum(["minimal", "moderate", "severe"]).optional(),
        current_weight_kg: z.number().positive().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool(
      "oedema_ascites_weight_adjustment_reference",
      async ({ oedema_severity, ascites_severity, current_weight_kg }) => {
        if (oedema_severity === undefined && ascites_severity === undefined) {
          return ok(
            { oedema_weight_adjustment_kg: OEDEMA_WEIGHT_ADJUSTMENT_KG, ascites_weight_adjustment_kg: ASCITES_WEIGHT_ADJUSTMENT_KG },
            { disclaimer: BWA_DISCLAIMER }
          );
        }
        const oedemaKg = oedema_severity ? OEDEMA_WEIGHT_ADJUSTMENT_KG[oedema_severity] : 0;
        const ascitesKg = ascites_severity ? ASCITES_WEIGHT_ADJUSTMENT_KG[ascites_severity] : 0;
        const totalAdjustmentKg = oedemaKg + ascitesKg;

        return ok(
          {
            oedema_severity,
            oedema_weight_adjustment_kg: oedema_severity ? oedemaKg : undefined,
            ascites_severity,
            ascites_weight_adjustment_kg: ascites_severity ? ascitesKg : undefined,
            total_weight_adjustment_kg: totalAdjustmentKg,
            adjusted_dry_weight_kg:
              current_weight_kg !== undefined ? Math.round((current_weight_kg - totalAdjustmentKg) * 100) / 100 : undefined,
          },
          { disclaimer: BWA_DISCLAIMER }
        );
      }
    )
  );

  // ── percent_ideal_body_weight_calculator ──────────────────────────────────
  server.registerTool(
    "percent_ideal_body_weight_calculator",
    {
      title: "Percent Ideal Body Weight (%IBW) Calculator",
      description:
        "Calculate %IBW = (current body weight / ideal body weight) x 100. Requires an externally supplied " +
        "ideal body weight, as this source does not specify an IBW formula. For nutritional risk " +
        "interpretation of the result, use ibw_ubw_nutritional_risk_interpreter. For spinal cord injury " +
        "patients, the IBW itself should first be adjusted downward — see " +
        "spinal_cord_injury_ibw_adjustment_reference.",
      inputSchema: {
        current_weight_kg: z.number().positive(),
        ideal_body_weight_kg: z.number().positive(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("percent_ideal_body_weight_calculator", async ({ current_weight_kg, ideal_body_weight_kg }) => {
      const percentIbw = (current_weight_kg / ideal_body_weight_kg) * 100;
      return ok(
        {
          percent_ideal_body_weight: Math.round(percentIbw * 10) / 10,
          formula: "%IBW = (current body weight / ideal body weight) x 100",
        },
        { disclaimer: BWA_DISCLAIMER, citation: "Lee & Nieman" }
      );
    })
  );

  // ── spinal_cord_injury_ibw_adjustment_reference ───────────────────────────
  server.registerTool(
    "spinal_cord_injury_ibw_adjustment_reference",
    {
      title: "Spinal Cord Injury IBW Adjustment Reference",
      description:
        "Reference for adjusting ideal body weight (IBW) downward in paraplegia or quadriplegia, since " +
        "immobility raises the risk of overweight at standard IBW. Paraplegia: subtract 5-10% (~4.5-7kg) " +
        "from standard IBW. Quadriplegia: subtract 10-15% (~7-9kg) from standard IBW. Provide " +
        "standard_ibw_kg to also compute the adjusted IBW range.",
      inputSchema: {
        injury_level: z.enum(["paraplegia", "quadriplegia"]),
        standard_ibw_kg: z.number().positive().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("spinal_cord_injury_ibw_adjustment_reference", async ({ injury_level, standard_ibw_kg }) => {
      const [pctLow, pctHigh] = injury_level === "paraplegia" ? [5, 10] : [10, 15];
      const absoluteRange = injury_level === "paraplegia" ? "4.5 - 7 kg" : "7 - 9 kg";
      return ok(
        {
          injury_level,
          subtract_percent_range: `${pctLow}% - ${pctHigh}%`,
          subtract_absolute_range: absoluteRange,
          adjusted_ibw_range_kg:
            standard_ibw_kg !== undefined
              ? {
                  low: Math.round(standard_ibw_kg * (1 - pctHigh / 100) * 100) / 100,
                  high: Math.round(standard_ibw_kg * (1 - pctLow / 100) * 100) / 100,
                }
              : undefined,
          rationale: "Desirable IBW is lower than median standards for para-/quadriplegia due to the risk of overweight from immobility.",
        },
        { disclaimer: BWA_DISCLAIMER, citation: "Lee & Nieman" }
      );
    })
  );

  // ── percent_weight_change_calculator ──────────────────────────────────────
  server.registerTool(
    "percent_weight_change_calculator",
    {
      title: "Percent Weight Change Calculator",
      description:
        "Calculate % weight change = [(usual weight - current weight) / usual weight] x 100. Positive " +
        "values indicate weight loss. Provide time_frame_weeks or time_frame_months (or omit both) to also " +
        "get the significant/severe weight-loss interpretation from weight_change_significance_interpreter " +
        "in the same call.",
      inputSchema: {
        current_weight_kg: z.number().positive(),
        usual_weight_kg: z.number().positive(),
        time_frame: z.enum(["1_week", "1_month", "3_months", "6_months"]).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("percent_weight_change_calculator", async ({ current_weight_kg, usual_weight_kg, time_frame }) => {
      const percentChange = ((usual_weight_kg - current_weight_kg) / usual_weight_kg) * 100;
      const timeFrameLabel = time_frame?.replace("_", " ");
      const row = timeFrameLabel ? WEIGHT_CHANGE_TABLE.find((r) => r.time_frame === timeFrameLabel) : undefined;

      let significance: string | undefined;
      if (row) {
        const sigThreshold = parseFloat(row.significant_weight_loss);
        const sevThreshold = parseFloat(row.severe_weight_loss.replace(">", "").trim());
        if (percentChange >= sevThreshold) significance = "Severe weight loss";
        else if (percentChange >= sigThreshold) significance = "Significant weight loss";
        else significance = "Not significant for this time frame";
      }

      return ok(
        {
          percent_weight_change: Math.round(percentChange * 100) / 100,
          direction: percentChange > 0 ? "loss" : percentChange < 0 ? "gain" : "no change",
          formula: "% weight change = [(usual weight - current weight) / usual weight] x 100",
          time_frame: timeFrameLabel,
          significance,
        },
        { disclaimer: BWA_DISCLAIMER, citation: "Lee & Nieman; Width & Reinhard" }
      );
    })
  );

  // ── ibw_ubw_nutritional_risk_interpreter ──────────────────────────────────
  server.registerTool(
    "ibw_ubw_nutritional_risk_interpreter",
    {
      title: "%IBW / %UBW Nutritional Risk Interpreter (Width & Reinhard)",
      description:
        "Interpret nutritional risk from %IBW and/or %UBW for males and non-pregnant females (Width & " +
        "Reinhard): >200 morbid obese; >120 obese; 110-120 overweight; 90-109 not at risk; 80-89% IBW / " +
        "85-95% UBW mild risk; 70-79% IBW / 75-84% UBW moderate risk; <70% IBW / <75% UBW severe risk. " +
        "Provide percent_ibw and/or percent_ubw (from percent_ideal_body_weight_calculator / " +
        "percent_usual_body_weight) to get the matching risk band, or omit both to see the full table.",
      inputSchema: {
        percent_ibw: z.number().positive().optional(),
        percent_ubw: z.number().positive().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("ibw_ubw_nutritional_risk_interpreter", async ({ percent_ibw, percent_ubw }) => {
      if (percent_ibw === undefined && percent_ubw === undefined) {
        return ok({ table: IBW_UBW_RISK_TABLE }, { disclaimer: BWA_DISCLAIMER, citation: "Width & Reinhard" });
      }

      function classifyIbw(v: number): string {
        if (v > 200) return "Morbid obese";
        if (v > 120) return "Obese";
        if (v >= 110) return "Overweight";
        if (v >= 90) return "Not at risk";
        if (v >= 80) return "Mild";
        if (v >= 70) return "Moderate";
        return "Severe";
      }
      function classifyUbw(v: number): string {
        if (v >= 95) return "Not at risk (or above mild-risk band)";
        if (v >= 85) return "Mild";
        if (v >= 75) return "Moderate";
        return "Severe";
      }

      return ok(
        {
          percent_ibw,
          ibw_risk: percent_ibw !== undefined ? classifyIbw(percent_ibw) : undefined,
          percent_ubw,
          ubw_risk: percent_ubw !== undefined ? classifyUbw(percent_ubw) : undefined,
          note: "Table applies to males and non-pregnant females.",
        },
        { disclaimer: BWA_DISCLAIMER, citation: "Width & Reinhard" }
      );
    })
  );

  // ── weight_change_significance_interpreter ────────────────────────────────
  server.registerTool(
    "weight_change_significance_interpreter",
    {
      title: "Weight Change Significance Interpreter (Width & Reinhard)",
      description:
        "Look up the significant/severe percent weight-loss thresholds by time frame (Width & Reinhard): " +
        "1 week — significant 1-2%, severe >2%; 1 month — significant 5%, severe >5%; 3 months — " +
        "significant 7.5%, severe >7.5%; 6 months — significant 10%, severe >10%. Provide percent_change " +
        "and time_frame to classify a specific result, or omit both to see the full table.",
      inputSchema: {
        percent_change: z.number().optional().describe("% weight loss (positive value) to classify"),
        time_frame: z.enum(["1_week", "1_month", "3_months", "6_months"]).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("weight_change_significance_interpreter", async ({ percent_change, time_frame }) => {
      if (percent_change === undefined || time_frame === undefined) {
        return ok({ table: WEIGHT_CHANGE_TABLE }, { disclaimer: BWA_DISCLAIMER, citation: "Width & Reinhard" });
      }
      const row = WEIGHT_CHANGE_TABLE.find((r) => r.time_frame === time_frame.replace("_", " "));
      if (!row) return err(`Unknown time_frame "${time_frame}".`);

      const sigThreshold = parseFloat(row.significant_weight_loss);
      const sevThreshold = parseFloat(row.severe_weight_loss.replace(">", "").trim());
      const significance =
        percent_change >= sevThreshold ? "Severe weight loss" : percent_change >= sigThreshold ? "Significant weight loss" : "Not significant";

      return ok(
        { percent_change, time_frame: row.time_frame, significance, thresholds: row },
        { disclaimer: BWA_DISCLAIMER, citation: "Width & Reinhard" }
      );
    })
  );
}
