import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { chakudyaClient } from "../clients/chakudyaClient.js";
import { safeTool } from "../utils/toolResult.js";
import { okWithApiMeta } from "../utils/apiMeta.js";

/**
 * ASPEN Consensus Recommendations for Refeeding Syndrome (RS).
 *
 * Source: da Silva JSV, Seres DS, Sabino K, et al. ASPEN Consensus
 * Recommendations for Refeeding Syndrome. Nutr Clin Pract. 2020;35(2):178-195.
 * DOI: 10.1002/ncp.10474.
 *
 * Four tools:
 * - aspen_refeeding_risk_adult      — Table 3 (risk stratification, 18y+)
 * - aspen_refeeding_risk_pediatric  — Table 5 (risk stratification, >28 days
 *                                     to <18y; not for neonates ≤28 days of
 *                                     life or ≤44 weeks corrected gestational
 *                                     age — the guide gives no pediatric-
 *                                     validated neonatal criteria)
 * - aspen_refeeding_syndrome_severity — the paper's core RS diagnostic
 *   definition: a decrease in phosphorus/potassium/magnesium of 10-20%
 *   (mild), 20-30% (moderate), or >30% and/or organ dysfunction or thiamin
 *   deficiency (severe), within 5 days of reinitiating/increasing calories.
 * - aspen_refeeding_initiation_guidance — Table 6 (adult) / Table 7
 *   (pediatric): weight-based initial calories/GIR, advancement, and
 *   electrolyte/thiamin/monitoring guidance for a patient at risk.
 *
 * Several Table 3/5 criteria (caloric-intake pattern, electrolyte trend,
 * physical-exam loss of fat/muscle, comorbidity severity) are not single
 * numbers — they're a clinician's qualitative read of a compound
 * description. Rather than guess at a purely numeric proxy, those criteria
 * are taken as an already-assessed level (none/moderate/significant, or
 * none/mild/moderate/significant for pediatrics) and only the criteria the
 * source table expresses as clean numeric thresholds (BMI, weight loss %,
 * z-score, MUAC z-score, days of low intake, electrolyte % decrease) are
 * auto-classified here.
 *
 * The logic and every cut-off, band, dose and text now live in chakudya-api
 * (src/refeedingNutrition.js, POST /refeeding/*), with the numbers read from the
 * clinical_reference_values table (condition 'refeeding'), so the API is the single
 * source of truth and values can be corrected in Supabase without redeploying this
 * server. These tools only pass the inputs through.
 *
 * Educational/clinical-support classification only, not a substitute for
 * individualized clinical assessment; these consensus criteria are based on expert
 * consensus, not randomized trial evidence, per the source paper.
 */

export function registerAspenRefeedingTools(server: McpServer): void {
  // ── Adult risk stratification (Table 3) ──────────────────────────────────
  server.registerTool(
    "aspen_refeeding_risk_adult",
    {
      title: "ASPEN Refeeding Syndrome Risk — Adults (Table 3)",
      description:
        "Stratify an adult (18y+) as moderate or significant risk for refeeding syndrome per ASPEN " +
        "Table 3. Moderate risk needs 2 of the criteria met at 'moderate' level; significant risk needs " +
        "just 1 criterion met at 'significant' level (significant always outranks moderate). BMI and " +
        "weight loss are auto-classified from numbers; the other criteria (caloric intake pattern, " +
        "prefeeding electrolyte abnormality, physical-exam loss of subcutaneous fat/muscle mass, " +
        "comorbidity severity) require your own clinical assessment against the ASPEN table wording — " +
        "pass the level you've already determined for each.",
      inputSchema: {
        bmi: z.number().positive().optional(),
        weight_loss_percent: z
          .number()
          .optional()
          .describe("Percent body weight lost; interpreted together with weight_loss_timeframe"),
        weight_loss_timeframe: z
          .enum(["1_month", "3_months", "6_months"])
          .optional()
          .describe(
            "Per Table 3: moderate = 5% in 1 month; significant = 7.5% in 3 months OR >10% in 6 months"
          ),
        caloric_intake_level: z
          .enum(["none", "moderate", "significant"])
          .optional()
          .describe(
            "Moderate: none/negligible oral intake 5-6 days, OR <75% of estimated need for >7 days " +
              "during acute illness/injury, OR <75% of estimated need for >1 month. Significant: " +
              "none/negligible oral intake >7 days, OR <50% of estimated need for >5 days during acute " +
              "illness/injury, OR <50% of estimated need for >1 month."
          ),
        prefeeding_electrolyte_abnormality_level: z
          .enum(["none", "moderate", "significant"])
          .optional()
          .describe(
            "Moderate: minimally low or normal current K/phosphorus/magnesium with recent low levels " +
              "needing minimal/single-dose supplementation. Significant: moderately/significantly low " +
              "levels, or minimally low/normal with recent low levels needing significant/multiple-dose " +
              "supplementation. Note electrolytes may be normal despite total-body deficiency."
          ),
        subcutaneous_fat_loss: z.enum(["none", "moderate", "significant"]).optional(),
        muscle_mass_loss: z.enum(["none", "moderate", "significant"]).optional(),
        comorbidity_severity: z
          .enum(["none", "moderate", "significant"])
          .optional()
          .describe(
            "Severity of a higher-RS-risk comorbidity (e.g. chronic alcohol/drug use disorder, eating " +
              "disorder, malabsorptive state, cancer, postbariatric surgery, prolonged fasting) if present"
          ),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safeTool("aspen_refeeding_risk_adult", async (input) => {
      const res = await chakudyaClient.post("/refeeding/risk-adult", input);
      return okWithApiMeta(res);
    })
  );

  // ── Pediatric risk stratification (Table 5) ─────────────────────────────
  server.registerTool(
    "aspen_refeeding_risk_pediatric",
    {
      title: "ASPEN Refeeding Syndrome Risk — Pediatric (Table 5)",
      description:
        "Stratify a pediatric patient (>28 days to <18y) as mild, moderate, or significant risk for " +
        "refeeding syndrome per ASPEN Table 5. Mild risk needs 3 criteria at 'mild' or higher; moderate " +
        "needs 2 at 'moderate' or higher; significant needs just 1 at 'significant' (higher levels " +
        "always outrank lower). NOT intended for neonates ≤28 days of life or ≤44 weeks corrected " +
        "gestational age — ASPEN gives no validated criteria for that group in this paper. Weight-for-" +
        "length/BMI-for-age z-score change, weight gain vs expected, energy-intake duration, and MUAC " +
        "z-score are auto-classified from numbers; electrolyte abnormality and comorbidity severity " +
        "require your own clinical assessment.",
      inputSchema: {
        z_score_change_from_baseline: z
          .number()
          .optional()
          .describe(
            "Change from baseline in weight-for-length z-score (1-24 months) or BMI-for-age z-score " +
              "(2-20 years). Mild -1 to -1.9, moderate -2 to -2.9, significant -3 or beyond."
          ),
        weight_gain_percent_of_expected: z
          .number()
          .optional()
          .describe(
            "Current weight gain as % of expected/norm. Mild <75%, moderate <50%, significant <25%."
          ),
        low_intake_days: z
          .number()
          .nonnegative()
          .optional()
          .describe(
            "Consecutive days of protein/energy intake <75% of estimated need. Mild 3-5 days, moderate " +
              "5-7 days, significant >7 days."
          ),
        prefeeding_electrolyte_abnormality_level: z
          .enum(["none", "mild", "moderate", "significant"])
          .optional()
          .describe(
            "Mild: mildly abnormal or decreased to 25% below lower limit of normal. Moderate/" +
              "significant: moderately/significantly abnormal or down to 25-50% below lower limit of " +
              "normal (the table gives the same wording for both moderate and significant columns)."
          ),
        comorbidity_severity: z.enum(["none", "mild", "moderate", "significant"]).optional(),
        subcutaneous_fat_loss: z
          .enum(["none", "mild", "moderate", "significant"])
          .optional()
          .describe("Direct clinical assessment; alternatively supply muac_z_score"),
        muscle_mass_loss: z
          .enum(["none", "moderate", "significant"])
          .optional()
          .describe(
            "Direct clinical assessment; note ASPEN gives no 'mild' criterion for muscle mass loss. " +
              "Alternatively supply muac_z_score."
          ),
        muac_z_score: z
          .number()
          .optional()
          .describe(
            "Mid-upper arm circumference z-score, used for BOTH subcutaneous-fat-loss and muscle-mass-" +
              "loss criteria per Table 5. Fat: mild -1 to -1.9, moderate -2 to -2.9, severe -3 or beyond. " +
              "Muscle: moderate -2 to -2.9, severe -3 or beyond (no mild band)."
          ),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safeTool("aspen_refeeding_risk_pediatric", async (input) => {
      const res = await chakudyaClient.post("/refeeding/risk-pediatric", input);
      return okWithApiMeta(res);
    })
  );

  // ── RS severity / diagnostic classification ─────────────────────────────
  server.registerTool(
    "aspen_refeeding_syndrome_severity",
    {
      title: "ASPEN Refeeding Syndrome Severity Classification",
      description:
        "Classify refeeding syndrome severity per the ASPEN consensus definition: a decrease in any 1, " +
        "2, or 3 of serum phosphorus, potassium, and/or magnesium by 10-20% (mild), 20-30% (moderate), " +
        "or >30% (severe), and/or organ dysfunction resulting from a decrease in any of these, and/or " +
        "due to thiamin deficiency (severe) — occurring within 5 days of reintroducing or substantially " +
        "increasing calorie provision after undernourishment. Supply baseline + current levels (any " +
        "consistent unit) for whichever electrolytes were measured, or a pre-computed percent_decrease " +
        "directly.",
      inputSchema: {
        phosphorus_baseline: z.number().positive().optional(),
        phosphorus_current: z.number().positive().optional(),
        phosphorus_percent_decrease: z.number().optional().describe("Use instead of baseline/current if already computed"),
        potassium_baseline: z.number().positive().optional(),
        potassium_current: z.number().positive().optional(),
        potassium_percent_decrease: z.number().optional(),
        magnesium_baseline: z.number().positive().optional(),
        magnesium_current: z.number().positive().optional(),
        magnesium_percent_decrease: z.number().optional(),
        organ_dysfunction_from_electrolyte_decrease: z
          .boolean()
          .optional()
          .describe("Any organ dysfunction resulting from a decrease in phosphorus, potassium, and/or magnesium"),
        thiamin_deficiency: z.boolean().optional(),
        within_5_days_of_refeeding: z
          .boolean()
          .optional()
          .describe(
            "Whether this occurred within 5 days of reinitiating/substantially increasing calorie " +
              "provision — required by the ASPEN definition for this to be classified as RS at all"
          ),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safeTool("aspen_refeeding_syndrome_severity", async (input) => {
      const res = await chakudyaClient.post("/refeeding/severity", input);
      return okWithApiMeta(res);
    })
  );

  // ── Initiation & advancement guidance (Table 6 adult / Table 7 pediatric) ─
  server.registerTool(
    "aspen_refeeding_initiation_guidance",
    {
      title: "ASPEN Refeeding Initiation & Advancement Guidance (Table 6/7)",
      description:
        "Weight-based initiation and advancement guidance for a patient at risk of refeeding syndrome, " +
        "per ASPEN Table 6 (adults 18y+) or Table 7 (pediatric). Adults: initiate at 10-20 kcal/kg/day " +
        "(or 100-150 g dextrose) for the first 24h, advancing by 33% of goal every 1-2 days. Pediatric: " +
        "initiate nutrition at a maximum of 40-50% of goal, starting the glucose infusion rate (GIR) " +
        "around 4-6 mg/kg/min and advancing 1-2 mg/kg/min daily up to a max of 14-18 mg/kg/min. Both " +
        "populations: delay/reduce initiation if prefeeding phosphorus/potassium/magnesium are severely " +
        "low, until corrected; electrolyte and thiamin dosing and monitoring cadence follow the same " +
        "pattern in both tables. This is general guidance only — Table 6/7 both note it 'may be changed " +
        "based on practitioner judgment and clinical presentation.'",
      inputSchema: {
        population: z.enum(["adult", "pediatric"]),
        weight_kg: z.number().positive(),
        at_risk_for_rs: z
          .boolean()
          .optional()
          .describe(
            "Whether this patient has been assessed as at risk for RS (e.g. via aspen_refeeding_risk_adult/" +
              "_pediatric) — determines whether the closer at-risk monitoring cadence applies"
          ),
        prefeeding_electrolytes_severely_low: z
          .boolean()
          .optional()
          .describe(
            "Severely low prefeeding phosphorus, potassium, or magnesium — both tables say initiation " +
              "of or increasing calories should be delayed until corrected in this case"
          ),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safeTool("aspen_refeeding_initiation_guidance", async (input) => {
      const res = await chakudyaClient.post("/refeeding/initiation", input);
      return okWithApiMeta(res);
    })
  );
}
