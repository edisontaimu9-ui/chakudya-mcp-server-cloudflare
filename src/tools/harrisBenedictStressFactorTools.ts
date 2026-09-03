import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, safeTool } from "../utils/toolResult.js";

/**
 * Harris-Benedict predictive energy equation, Barak et al (2002) clinical
 * stress factor table, and the accompanying 24-hour energy expenditure
 * adjustment factors (ventilation, body temperature, sedation, activity),
 * as compiled in a hospital dietetics "Predictive energy equations"
 * reference sheet (section 1.2).
 *
 * Pure calculation / reference lookup — no Chakudya API calls.
 *
 * Three tools:
 *   - harris_benedict_bee_calculator
 *   - stress_factor_reference (Barak et al, 2002)
 *   - twenty_four_hour_energy_adjustment_reference
 */

const HB_DISCLAIMER =
  "Reference/estimate only, from the classic Harris-Benedict predictive energy equation (1919 coefficients " +
  "as commonly reproduced in hospital dietetics guidelines) and the accompanying Barak et al (2002) stress " +
  "factor and 24-hour adjustment tables. When more than one stress factor applies, use the highest one — " +
  "do not multiply several together. Not a substitute for individualized clinical assessment; indirect " +
  "calorimetry is preferred where available.";

function err(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

// ── Barak et al (2002) stress factor table ──────────────────────────────────
interface StressFactorRow {
  key: string;
  condition: string;
  factor_range: string;
  factor_low: number;
  factor_high: number;
  note?: string;
}

const STRESS_FACTOR_TABLE: StressFactorRow[] = [
  { key: "starvation_refeeding", condition: "Starvation/refeeding risk", factor_range: "0.75 - 1.00", factor_low: 0.75, factor_high: 1.0 },
  { key: "postop_no_complication", condition: "Post-operatively (no complication)", factor_range: "1.05 - 1.15", factor_low: 1.05, factor_high: 1.15 },
  { key: "general_surgery", condition: "General Surgery (major or with complications)", factor_range: "1.2 - 1.4", factor_low: 1.2, factor_high: 1.4 },
  { key: "organ_transplantation", condition: "Organ transplantation", factor_range: "1.2", factor_low: 1.2, factor_high: 1.2 },
  { key: "active_ibd", condition: "Active IBD", factor_range: "1.1 (1.2-1.25 for weight gain)", factor_low: 1.1, factor_high: 1.1, note: "1.2-1.25 if the goal is weight gain rather than maintenance" },
  { key: "fracture", condition: "Fracture", factor_range: "1.25 - 1.30", factor_low: 1.25, factor_high: 1.3 },
  { key: "sepsis_mild", condition: "Sepsis/infection: mild (e.g. local infection, patient stable)", factor_range: "1.15 - 1.30", factor_low: 1.15, factor_high: 1.3 },
  { key: "sepsis_severe", condition: "Severe sepsis (i.e. systemic sepsis)", factor_range: "1.3 - 1.45", factor_low: 1.3, factor_high: 1.45 },
  { key: "peritonitis", condition: "Peritonitis (according to extent of peritonitis)", factor_range: "1.05 - 1.4", factor_low: 1.05, factor_high: 1.4 },
  { key: "multiple_trauma", condition: "Multiple trauma / multiple trauma with severe infection", factor_range: "1.30 - 1.55", factor_low: 1.3, factor_high: 1.55 },
  { key: "respiratory_failure_copd", condition: "Respiratory failure/COPD (non-ventilated)", factor_range: "1.00 - 1.25", factor_low: 1.0, factor_high: 1.25 },
  { key: "active_tb", condition: "Active TB (WHO, 2003)", factor_range: "at least 1.3 (up to 1.7)", factor_low: 1.3, factor_high: 1.7 },
  { key: "acute_pancreatitis", condition: "Acute Pancreatitis (Dickerson, 1991; Bouffard, 1989)", factor_range: "1.1 - 1.4", factor_low: 1.1, factor_high: 1.4 },
  { key: "chronic_pancreatitis", condition: "Chronic Pancreatitis", factor_range: "1.03", factor_low: 1.03, factor_high: 1.03 },
  { key: "septic_pancreatitis", condition: "Septic Pancreatitis", factor_range: "1.2", factor_low: 1.2, factor_high: 1.2 },
  { key: "severe_septic_acute_pancreatitis", condition: "Severe/Septic Acute Pancreatitis (Dickerson, 1991; Bouffard, 1989)", factor_range: "1.8 - 2.0", factor_low: 1.8, factor_high: 2.0 },
  { key: "tbi_closed_head_injury", condition: "Traumatic Brain Injury/Closed head injury (Cook et al, 2008)", factor_range: "1.4", factor_low: 1.4, factor_high: 1.4 },
  { key: "tbi_with_other_injuries", condition: "TBI/CHI with other injuries/fractures (Cook et al, 2008)", factor_range: "1.6", factor_low: 1.6, factor_high: 1.6 },
  { key: "acute_spinal_cord_injury", condition: "Acute spinal cord injury (ASCI): paraplegia; tetraplegia", factor_range: "0.65 - 0.85; 0.5", factor_low: 0.5, factor_high: 0.85, note: "Paraplegia 0.65-0.85; tetraplegia 0.5" },
  { key: "icu_septic", condition: "ICU: septic", factor_range: "1.2 - 1.6", factor_low: 1.2, factor_high: 1.6 },
  { key: "cva", condition: "CVA", factor_range: "1.05", factor_low: 1.05, factor_high: 1.05 },
  { key: "leukaemia", condition: "Leukaemia", factor_range: "1.3", factor_low: 1.3, factor_high: 1.3 },
  { key: "lymphoma", condition: "Lymphoma", factor_range: "1.3", factor_low: 1.3, factor_high: 1.3 },
  { key: "solid_tumours", condition: "Solid tumours", factor_range: "1.2", factor_low: 1.2, factor_high: 1.2 },
  { key: "liver_disease", condition: "Liver Disease", factor_range: "1.3 - 1.4", factor_low: 1.3, factor_high: 1.4 },
  { key: "wound_healing", condition: "Wound healing", factor_range: "1.5", factor_low: 1.5, factor_high: 1.5 },
];

// ── 24-hour energy expenditure adjustment factors ───────────────────────────
const TWENTY_FOUR_HOUR_ADJUSTMENTS = {
  ventilation: { factor: 0.95, note: "Multiply BEE x stress factor by 0.95 if mechanically ventilated." },
  body_temperature: {
    per_degree_c_above_37: "+13%",
    per_degree_c_below_37: "-13%",
    note: "For every 1°C above 37°C, add 13%; for every 1°C below 37°C, subtract 13% (applied to the stress-factor-adjusted value).",
  },
  sedatives_paralytics_barbiturates: { factor_range: "0.75 - 1.00", factor_low: 0.75, factor_high: 1.0 },
  activity_bedridden_awake: { factor_range: "1.1 - 1.2", factor_low: 1.1, factor_high: 1.2 },
  activity_very_restless: { factor_range: "1.2 - 1.45", factor_low: 1.2, factor_high: 1.45 },
  instruction: "Always multiply these factors with BEE (or with BEE x stress factor, if a stress factor also applies).",
};

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
        "stress factor would apply clinically, pass only the single highest one — per source, do not stack them.",
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
          .describe(
            "Optional additional 24-hour adjustment factor (ventilation, sedation, activity) to multiply by."
          ),
        body_temp_c: z
          .number()
          .optional()
          .describe("Optional body temperature in °C; applies ±13% per °C above/below 37°C to the running total."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool(
      "harris_benedict_bee_calculator",
      async ({ sex, weight_kg, height_cm, age_years, stress_factor, adjustment_factor, body_temp_c }) => {
        const bee =
          sex === "male"
            ? 66.5 + 13.8 * weight_kg + 5.0 * height_cm - 6.8 * age_years
            : 655.1 + 9.6 * weight_kg + 1.9 * height_cm - 4.7 * age_years;

        if (bee <= 0) {
          return err("Computed BEE is non-positive — check the input values (weight, height, age).");
        }

        let running = bee;
        const applied: string[] = [];

        if (stress_factor !== undefined) {
          running *= stress_factor;
          applied.push(`x ${stress_factor} (stress factor)`);
        }
        if (adjustment_factor !== undefined) {
          running *= adjustment_factor;
          applied.push(`x ${adjustment_factor} (24h adjustment factor)`);
        }
        if (body_temp_c !== undefined) {
          const degreesFrom37 = body_temp_c - 37;
          const pctChange = degreesFrom37 * 13;
          running *= 1 + pctChange / 100;
          applied.push(
            `${pctChange >= 0 ? "+" : ""}${Math.round(pctChange * 10) / 10}% (body temp ${body_temp_c}°C vs 37°C, 13%/°C)`
          );
        }

        return ok(
          {
            sex,
            weight_kg,
            height_cm,
            age_years,
            bee_kcal_per_day: Math.round(bee),
            formula:
              sex === "male"
                ? "66.5 + 13.8(Wt kg) + 5.0(Ht cm) - 6.8(Age)"
                : "655.1 + 9.6(Wt kg) + 1.9(Ht cm) - 4.7(Age)",
            adjustments_applied: applied.length > 0 ? applied : "none",
            adjusted_kcal_per_day: Math.round(running),
            note:
              "If a clinical condition applies, look up its factor with stress_factor_reference and pass it as " +
              "stress_factor; for 24h adjustments (ventilation, sedation, activity level) use " +
              "twenty_four_hour_energy_adjustment_reference. Use the highest single applicable stress factor only.",
          },
          { disclaimer: HB_DISCLAIMER, citation: "Harris-Benedict equation; stress factors per Barak et al, 2002" }
        );
      }
    )
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
        "of several. Provide a condition_key to look up one row, or omit it to return the full table.",
      inputSchema: {
        condition_key: z
          .enum(STRESS_FACTOR_TABLE.map((r) => r.key) as [string, ...string[]])
          .optional()
          .describe("Optional key for a single condition. Omit to return the full table."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("stress_factor_reference", async ({ condition_key }) => {
      if (condition_key !== undefined) {
        const row = STRESS_FACTOR_TABLE.find((r) => r.key === condition_key);
        if (!row) {
          return err(
            `Unknown condition_key "${condition_key}". Omit condition_key to see the full table of valid keys.`
          );
        }
        return ok(row, {
          disclaimer: HB_DISCLAIMER,
          citation: "Barak et al, 2002",
          usage_note: "If more than one stress factor could apply, use only the single highest one.",
        });
      }
      return ok(
        { conditions: STRESS_FACTOR_TABLE },
        {
          disclaimer: HB_DISCLAIMER,
          citation: "Barak et al, 2002",
          usage_note: "If more than one stress factor could apply, use only the single highest one.",
        }
      );
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
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("twenty_four_hour_energy_adjustment_reference", async () => {
      return ok(TWENTY_FOUR_HOUR_ADJUSTMENTS, {
        disclaimer: HB_DISCLAIMER,
        citation: "Hospital dietetics 'Predictive energy equations' reference sheet, section 1.2",
      });
    })
  );
}
