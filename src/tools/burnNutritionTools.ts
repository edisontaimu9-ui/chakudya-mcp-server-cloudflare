import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, safeTool } from "../utils/toolResult.js";

/**
 * Medical Nutrition Therapy in Burns.
 *
 * Source: Abillama F. Medical Nutrition Therapy in Burns: Optimizing
 * Healing and Recovery. LAUMCRH Beirut Lebanon — teaching slide deck citing
 * ESPEN endorsed recommendations (Rousseau et al, Clin Nutr 2013;32:497-502),
 * Williams et al (Surg Clin North Am 2011), Wise/Miller/Hromatka (Nutr Clin
 * Pract 2019), Pantet et al (Clin Nutr 2019;38:246-251), and the deck's own
 * Toronto/Schofield/Parkland formula citations (see each tool's notes).
 *
 * Five tools:
 * - burn_fluid_resuscitation_parkland — Parkland/Baxter formula (>10% TBSA)
 * - burn_energy_requirements          — Toronto (adults) / Schofield
 *                                        (pediatric 3-18y) predictive REE
 * - burn_protein_requirements         — g/kg/day + NPC:N ratio by burn size
 * - burn_nitrogen_balance             — nitrogen balance + Gottschlich (1993)
 *                                        burned-tissue N-loss estimate
 * - burn_micronutrient_dosing         — vitamin/trace-element dosing guidance
 *                                        by burn size, per ESPEN + case-study
 *                                        sources cited in the deck
 *
 * IMPORTANT — per the deck itself: "NO predictive equation is accurate."
 * Indirect calorimetry (in the fed state, at several points during
 * hospitalization) is the gold standard; these formulas are fallbacks when
 * it isn't available. All tools here are calculators/classifiers only, not
 * a substitute for individualized clinical judgment.
 */

const BURN_DISCLAIMER =
  "Educational/clinical-support calculation only, per Abillama F. Medical Nutrition Therapy in Burns " +
  "(LAUMCRH Beirut Lebanon), citing ESPEN endorsed recommendations (Rousseau et al, Clin Nutr " +
  "2013;32:497-502) and sources noted per tool. Indirect calorimetry is the gold standard for energy " +
  "needs when available — no predictive equation is fully accurate. Not a substitute for individualized " +
  "clinical assessment.";

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
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("burn_fluid_resuscitation_parkland", async ({ weight_kg, tbsa_burned_percent, hours_since_burn }) => {
      const totalMl = 4 * weight_kg * tbsa_burned_percent;
      const first8hMl = totalMl / 2;
      const next16hMl = totalMl / 2;
      const first8hRateMlPerHr = first8hMl / 8;
      const next16hRateMlPerHr = next16hMl / 16;

      const notes: string[] = [];
      if (tbsa_burned_percent <= 10) {
        notes.push(
          "TBSA is <=10% — the Parkland formula is indicated for burns >10% TBSA; smaller burns " +
            "typically don't need formal formula-driven resuscitation. Result shown for reference only."
        );
      }

      let remaining: Record<string, number> | undefined;
      if (hours_since_burn !== undefined) {
        if (hours_since_burn < 8) {
          const elapsedFirst8h = hours_since_burn;
          remaining = {
            remaining_ml_in_first_8h_window: Math.max(0, first8hMl - elapsedFirst8h * first8hRateMlPerHr),
            hours_remaining_in_first_8h_window: 8 - elapsedFirst8h,
          };
        } else if (hours_since_burn < 24) {
          const elapsedInNext16h = hours_since_burn - 8;
          remaining = {
            remaining_ml_in_next_16h_window: Math.max(0, next16hMl - elapsedInNext16h * next16hRateMlPerHr),
            hours_remaining_in_24h_period: 24 - hours_since_burn,
          };
        } else {
          notes.push("hours_since_burn is >=24 — the initial 24h Parkland window has elapsed.");
        }
      }

      return ok(
        {
          total_24h_ml: Math.round(totalMl),
          first_8h_ml: Math.round(first8hMl),
          first_8h_rate_ml_per_hr: Math.round(first8hRateMlPerHr),
          next_16h_ml: Math.round(next16hMl),
          next_16h_rate_ml_per_hr: Math.round(next16hRateMlPerHr),
          ...(remaining ? { remaining } : {}),
          formula: "4 mL x weight(kg) x %TBSA burned; half in first 8h post-burn, half over next 16h",
          notes,
        },
        { disclaimer: BURN_DISCLAIMER, citation: "Baxter CR, 1974 (Parkland formula)" }
      );
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
        "per the source). Children 3-18y: Schofield weight+height equation, age- and sex-specific. " +
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
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool(
      "burn_energy_requirements",
      async ({ weight_kg, height_cm, age_years, sex, tbsa_burned_percent, kcal_intake_past_24h, body_temp_c, days_post_burn }) => {
        const isPediatric = age_years < 18;

        if (isPediatric) {
          if (age_years < 3) {
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    "The deck's Schofield table only covers ages 3-18y. For age <3y, use indirect " +
                    "calorimetry or a validated infant/toddler predictive equation not covered by this tool.",
                },
              ],
              isError: true as const,
            };
          }
          const band = age_years < 10 ? "3-10" : "10-18";
          let kcalPerDay: number;
          let formula: string;
          if (band === "3-10" && sex === "female") {
            kcalPerDay = 16.97 * weight_kg + 1.618 * height_cm + 371.2;
            formula = "Schofield (girls 3-10y): (16.97 x weight_kg) + (1.618 x height_cm) + 371.2";
          } else if (band === "3-10" && sex === "male") {
            kcalPerDay = 19.6 * weight_kg + 1.033 * height_cm + 414.9;
            formula = "Schofield (boys 3-10y): (19.6 x weight_kg) + (1.033 x height_cm) + 414.9";
          } else if (band === "10-18" && sex === "female") {
            kcalPerDay = 8.365 * weight_kg + 4.65 * height_cm + 200;
            formula = "Schofield (girls 10-18y): (8.365 x weight_kg) + (4.65 x height_cm) + 200";
          } else {
            kcalPerDay = 16.25 * weight_kg + 1.372 * height_cm + 515.5;
            formula = "Schofield (boys 10-18y): (16.25 x weight_kg) + (1.372 x height_cm) + 515.5";
          }
          return ok(
            {
              population: "pediatric",
              age_band: band,
              estimated_kcal_per_day: Math.round(kcalPerDay),
              formula,
            },
            { disclaimer: BURN_DISCLAIMER, citation: "Schofield equation, pediatric weight+height table" }
          );
        }

        // Adult — Toronto equation
        const missing: string[] = [];
        if (tbsa_burned_percent === undefined) missing.push("tbsa_burned_percent");
        if (kcal_intake_past_24h === undefined) missing.push("kcal_intake_past_24h");
        if (body_temp_c === undefined) missing.push("body_temp_c");
        if (days_post_burn === undefined) missing.push("days_post_burn");
        if (missing.length > 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Adult (Toronto equation) requires: ${missing.join(", ")}.`,
              },
            ],
            isError: true as const,
          };
        }

        const harrisBenedictBasal =
          sex === "male"
            ? 66.47 + 13.75 * weight_kg + 5.003 * height_cm - 6.755 * age_years
            : 655.1 + 9.563 * weight_kg + 1.85 * height_cm - 4.676 * age_years;

        const reeKcal =
          -4343 +
          10.5 * tbsa_burned_percent! +
          0.23 * kcal_intake_past_24h! +
          0.84 * harrisBenedictBasal +
          114 * body_temp_c! -
          4.5 * days_post_burn!;

        // Reference-only rough estimate the deck warns tends to underfeed —
        // shown for comparison, not as the primary recommendation.
        const rapidFormulaRangeKcal = { low: 25 * weight_kg, high: 30 * weight_kg };

        return ok(
          {
            population: "adult",
            harris_benedict_basal_kcal: Math.round(harrisBenedictBasal),
            toronto_ree_kcal: Math.round(reeKcal),
            formula:
              "REE = -4343 + (10.5 x %TBSA burned) + (0.23 x kcal intake past 24h) + (0.84 x Harris-Benedict) + (114 x T degC) - (4.5 x days post-burn)",
            reference_only_rapid_formula_kcal_range: {
              ...rapidFormulaRangeKcal,
              note: "25-30 kcal/kg/day — per the source, this rapid formula tends to UNDERFEED burn patients. Shown for comparison only.",
            },
            note: "Per source: no predictive equation is fully accurate; indirect calorimetry (fed state, repeated through hospitalization) is the gold standard where available.",
          },
          { disclaimer: BURN_DISCLAIMER, citation: "Toronto equation; Harris-Benedict basal (no stress/activity factor)" }
        );
      }
    )
  );

  // ── Protein requirements ─────────────────────────────────────────────────
  server.registerTool(
    "burn_protein_requirements",
    {
      title: "Burn Protein Requirements",
      description:
        "Estimate protein needs (g/kg/day) and the target non-protein-calorie:nitrogen (NPC:N) ratio " +
        "by burn size, per ESPEN endorsed recommendations. Burn patients need substantially higher " +
        "protein than other critically ill patients: ESPEN/ASPEN adults 1.5-2 g/kg/day, children " +
        "3 g/kg/day.",
      inputSchema: {
        tbsa_burned_percent: z.number().min(0).max(100),
        weight_kg: z.number().positive().optional().describe("If given, also returns total grams/day"),
        is_pediatric: z.boolean().optional().describe("If true, uses the flat 3 g/kg/day pediatric recommendation"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("burn_protein_requirements", async ({ tbsa_burned_percent, weight_kg, is_pediatric }) => {
      if (is_pediatric) {
        const gPerKg = 3;
        return ok(
          {
            protein_g_per_kg_per_day: gPerKg,
            total_grams_per_day: weight_kg ? Math.round(gPerKg * weight_kg) : undefined,
            note: "Flat pediatric recommendation per ESPEN endorsed recommendations, higher than other critically ill patient categories.",
          },
          { disclaimer: BURN_DISCLAIMER, citation: "Rousseau et al, Clin Nutr 2013;32:497-502 (ESPEN endorsed recommendations)" }
        );
      }

      let range: { low: number; high: number };
      let npcNRatio: string;
      if (tbsa_burned_percent < 15) {
        range = { low: 1.0, high: 1.5 };
        npcNRatio = "150:1";
      } else if (tbsa_burned_percent <= 30) {
        range = { low: 1.5, high: 1.5 };
        npcNRatio = "120:1";
      } else if (tbsa_burned_percent <= 49) {
        range = { low: 1.5, high: 2.0 };
        npcNRatio = "100:1";
      } else {
        range = { low: 2.0, high: 2.3 };
        npcNRatio = "100:1";
      }

      return ok(
        {
          burn_size_band_percent: tbsa_burned_percent < 15 ? "<15" : tbsa_burned_percent <= 30 ? "15-30" : tbsa_burned_percent <= 49 ? "31-49" : "50+",
          protein_g_per_kg_per_day_range: range,
          total_grams_per_day_range: weight_kg
            ? { low: Math.round(range.low * weight_kg), high: Math.round(range.high * weight_kg) }
            : undefined,
          non_protein_calorie_to_nitrogen_ratio: npcNRatio,
          general_adult_range_g_per_kg_per_day: { low: 1.5, high: 2.0 },
          adequacy_can_be_evaluated_by: ["Wound healing of burn and donor sites", "Adherence of skin grafts", "Nitrogen balance"],
        },
        { disclaimer: BURN_DISCLAIMER, citation: "Rousseau et al, Clin Nutr 2013;32:497-502 (ESPEN endorsed recommendations)" }
      );
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
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("burn_nitrogen_balance", async ({ protein_intake_g, uun_g, open_wound_percent, weight_kg }) => {
      const nitrogenBalance = protein_intake_g / 6.25 - uun_g / 0.8 + 4;

      let burnedTissueNLossGPerKgPerDay: number | undefined;
      let burnedTissueBand: string | undefined;
      if (open_wound_percent !== undefined) {
        if (open_wound_percent < 10) {
          burnedTissueNLossGPerKgPerDay = 0.02;
          burnedTissueBand = "<10% open wound";
        } else if (open_wound_percent <= 30) {
          burnedTissueNLossGPerKgPerDay = 0.05;
          burnedTissueBand = "11-30% open wound";
        } else {
          burnedTissueNLossGPerKgPerDay = 0.12;
          burnedTissueBand = ">31% open wound";
        }
      }

      return ok(
        {
          nitrogen_balance_g_per_day: Math.round(nitrogenBalance * 100) / 100,
          interpretation: nitrogenBalance > 0 ? "positive (anabolic)" : nitrogenBalance < 0 ? "negative (catabolic)" : "neutral",
          formula: "Nitrogen Balance = (protein_intake_g / 6.25) - (UUN_g / 0.8) + 4",
          ...(burnedTissueNLossGPerKgPerDay !== undefined
            ? {
                estimated_burned_tissue_nitrogen_loss: {
                  band: burnedTissueBand,
                  g_nitrogen_per_kg_per_day: burnedTissueNLossGPerKgPerDay,
                  total_g_per_day: weight_kg ? Math.round(burnedTissueNLossGPerKgPerDay * weight_kg * 100) / 100 : undefined,
                  note: "Nitrogen losses through burned tissue are difficult to quantify precisely; this is an estimate (Gottschlich, 1993). Losses should begin to decrease as wounds heal or engraft.",
                },
              }
            : {}),
        },
        { disclaimer: BURN_DISCLAIMER, citation: "Gottschlich, 1993 (burned-tissue nitrogen loss estimate)" }
      );
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
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool(
      "burn_micronutrient_dosing",
      async ({ tbsa_burned_percent, bmi, age_years, chronically_malnourished, open_wound_percent }) => {
        const vitaminAHalfDoseCriteriaMet =
          (bmi !== undefined && bmi < 18) || (age_years !== undefined && age_years < 18) || chronically_malnourished === true;

        let traceElementDuration: string;
        if (tbsa_burned_percent < 20) {
          traceElementDuration = "Not specifically covered by the cited duration table (starts at 20% TBSA)";
        } else if (tbsa_burned_percent <= 40) {
          traceElementDuration = "7-8 days";
        } else if (tbsa_burned_percent <= 60) {
          traceElementDuration = "2 weeks";
        } else {
          traceElementDuration = "30 days";
        }

        return ok(
          {
            multivitamin: "Once per day (Vitamin A, B, C, E, D + Thiamin — thiamin normalizes lactate & pyruvate metabolism)",
            vitamin_a: {
              standard_dose: "10,000 IU once per day",
              half_dose_and_discontinue_recommended: vitaminAHalfDoseCriteriaMet,
              half_dose_criteria: "BMI <18, OR age <18, OR chronically malnourished",
              discontinue_when: "wounds <10% open",
              caution: "Watch for hypercalcemia secondary to Vitamin A overdose, especially with asymptomatic hypercalcemia + normal PTH + normal Vitamin D.",
            },
            vitamin_c: {
              standard_recommendation: "0.5-1 g/day (needs remain elevated in the acute phase); doses 1.5-3x RDA reduce oxidative stress and improve wound healing",
              note_separate_high_dose_iv_protocol:
                "A distinct high-dose IV protocol (66 mg/kg/hr continuous infusion, up to 10g within first 2 days) is reported in some studies to reduce fluid requirements and in-hospital mortality, but carries AKI/renal failure risk — this is a specific studied protocol, not the standard ESPEN daily recommendation.",
            },
            vitamin_d: {
              note: "Deficiency present in >90% of burn patients (often profound); 400 IU/day standard intake is insufficient and does not improve bone density. Low-cost, low-risk — may reduce length of stay. Long-term supplementation may be needed for bone homeostasis.",
            },
            vitamin_e: {
              note: "No single ESPEN numeric dose given in this source; doses 1.5-3x RDA (combined with Vitamin C) associated with reduced oxidative stress and improved wound healing. Direct wound application also reported to improve outcomes.",
            },
            trace_elements_iv_repletion: {
              duration_by_burn_size: traceElementDuration,
              duration_table: { "20-40% TBSA": "7-8 days", "40-60% TBSA": "2 weeks", ">60% TBSA": "30 days" },
              max_daily_iv_intake_vs_rda: {
                copper: { max_iv_mg: 4.77, rda_mcg: 900 },
                selenium: { max_iv_mcg: 273, rda_mcg: 55 },
                zinc: { max_iv_mg: 45.5, rda_mg: 11 },
              },
              note: "Copper, selenium, and zinc are lost in large amounts via exudative losses. Competition between copper and zinc for intestinal absorption means enteral substitution at these doses is inefficient — IV route may be needed.",
            },
          },
          { disclaimer: BURN_DISCLAIMER, citation: "Rousseau et al 2013 (ESPEN); Pantet et al, Clin Nutr 2019;38:246-251; Zeitouni et al 2022 (Vitamin A); Siddiqi et al 2022 / Nakajima et al 2019 (Vitamin C)" }
        );
      }
    )
  );
}
