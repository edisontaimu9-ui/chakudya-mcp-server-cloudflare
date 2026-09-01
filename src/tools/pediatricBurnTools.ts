import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, safeTool } from "../utils/toolResult.js";

/**
 * Nutrition in Pediatric Burns.
 *
 * Source: Mrazek AA, Simpson P, Lee JO. Nutrition in Pediatric Burns.
 * Semin Plast Surg. 2024;38:125-132. DOI: 10.1055/s-0044-1782648.
 *
 * Four tools:
 * - burn_pediatric_maintenance_fluid_holliday_segar — daily MAINTENANCE
 *   fluid (Holliday-Segar). Distinct from burn_fluid_resuscitation_parkland
 *   in burnNutritionTools.ts, which covers acute RESUSCITATION fluid for
 *   burns >10% TBSA — the two serve different clinical purposes and are not
 *   interchangeable.
 * - burn_indirect_calorimetry_ree — Weir equation, converting measured VO2
 *   /VCO2 into REE, the gold-standard measurement this source (and the
 *   ESPEN paper already in this tool set) both prefer over any predictive
 *   equation.
 * - burn_pediatric_predictive_equations_comparison — Table 1's five
 *   predictive-equation families (Curreri Junior, Galveston, Mayes,
 *   Schofield [weight-only pediatric version — NOTE: this differs from the
 *   weight+height Schofield equations in burnNutritionTools.ts, which come
 *   from a different source: Rousseau et al 2013. Both are legitimately
 *   published "Schofield" variants; they are not the same formula and will
 *   not agree], WHO), returned side by side per the source's own comparative
 *   framing — deliberately not collapsed to one answer, since the paper's
 *   central point is that ALL of these formulas have historically
 *   overpredicted BMR and led to overfeeding, and recommends using measured
 *   REE (indirect calorimetry) to guide support instead.
 * - burn_hypermetabolism_pharmacologic_dosing — dosing reference for growth
 *   hormone, IGF-1/IGFBP-3, insulin, propranolol, and oxandrolone. Includes
 *   a regulatory flag this paper itself notes: the FDA withdrew approval
 *   for oxandrolone (brand Oxandrin and generics) on June 23, 2023 over
 *   safety concerns — a fact not present in the earlier ESPEN 2013 source
 *   in this tool set, which predates that withdrawal by a decade.
 *
 * Pure lookup/calculation tools — no Chakudya API calls. Educational/
 * clinical-support only, not a substitute for individualized clinical
 * assessment or current prescribing information.
 */

const PEDIATRIC_BURN_DISCLAIMER =
  "Educational/clinical-support calculation only, per Mrazek AA, Simpson P, Lee JO. Nutrition in " +
  "Pediatric Burns. Semin Plast Surg. 2024;38:125-132. Not a substitute for individualized clinical " +
  "assessment or current prescribing information — verify drug approval status independently, as " +
  "regulatory status can change after this source's publication date (2024).";

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
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("burn_pediatric_maintenance_fluid_holliday_segar", async ({ weight_kg }) => {
      let dailyMl: number;
      let breakdown: string;
      if (weight_kg <= 10) {
        dailyMl = 100 * weight_kg;
        breakdown = `100 mL/kg x ${weight_kg}kg`;
      } else if (weight_kg <= 20) {
        dailyMl = 1000 + 50 * (weight_kg - 10);
        breakdown = `1000 mL + (50 mL/kg x ${weight_kg - 10}kg over 10kg)`;
      } else {
        dailyMl = 1500 + 20 * (weight_kg - 20);
        breakdown = `1500 mL + (20 mL/kg x ${weight_kg - 20}kg over 20kg)`;
      }

      return ok(
        {
          daily_maintenance_ml: Math.round(dailyMl),
          hourly_rate_ml_per_hr: Math.round((dailyMl / 24) * 10) / 10,
          breakdown,
          note: "This is baseline maintenance fluid, distinct from acute burn resuscitation volume. Free water requirements beyond the enteral formula's content are typically met with intermittent fluid boluses on top of this.",
        },
        { disclaimer: PEDIATRIC_BURN_DISCLAIMER, citation: "Holliday MA, Segar WE. Pediatrics 1957;19(05):823-832" }
      );
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
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool(
      "burn_indirect_calorimetry_ree",
      async ({ vo2_ml_per_min, vco2_ml_per_min, apply_activity_factor, daytime_variability_percent, tbsa_burned_percent }) => {
        const reeKcalPerDay = 1.44 * (3.9 * vo2_ml_per_min + 1.1 * vco2_ml_per_min);

        const result: Record<string, unknown> = {
          measured_ree_kcal_per_day: Math.round(reeKcalPerDay),
          formula: "REE (kcal/day) = 1.44 x (3.9 x VO2[mL/min] + 1.1 x VCO2[mL/min])",
        };

        if (apply_activity_factor) {
          result.total_energy_expenditure_kcal_per_day = Math.round(reeKcalPerDay * 1.4);
          result.activity_factor_note = "REE x 1.4 meets the needs of 95% of burn patients per source (Wolf et al, 1997).";
        }

        if (daytime_variability_percent !== undefined) {
          result.daytime_adjusted_ree_kcal_per_day = Math.round(reeKcalPerDay * (1 + daytime_variability_percent / 100));
        }

        let tbsaContext: string | undefined;
        if (tbsa_burned_percent !== undefined) {
          if (tbsa_burned_percent < 10) {
            tbsaContext = "TBSA <10%: REE is typically comparable to non-burned controls.";
          } else if (tbsa_burned_percent > 40) {
            tbsaContext =
              "TBSA >40%: REE is typically ~150% of predicted during the first 2 weeks post-burn, decreasing to ~135% once wounds are closed. REE remains significantly elevated for up to 24 months post-burn.";
          } else {
            tbsaContext = "REE does not correlate cleanly with burn size at this range and is influenced by multiple variables; measured REE is preferred over estimation.";
          }
        }

        return ok(
          { ...result, tbsa_context: tbsaContext },
          { disclaimer: PEDIATRIC_BURN_DISCLAIMER, citation: "Weir JB. J Physiol 1949;109(1-2):1-9 (modified Weir equation)" }
        );
      }
    )
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
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("burn_pediatric_predictive_equations_comparison", async ({ sex, age_years, weight_kg, tbsa_burned_percent }) => {
      const results: Array<{ equation: string; age_band: string; kcal_per_day: number; formula: string }> = [];
      const skipped: string[] = [];

      // Curreri Junior (needs an RDA base value from its own age-banded table, plus TBSA)
      if (tbsa_burned_percent === undefined) {
        skipped.push("Curreri Junior (needs tbsa_burned_percent)");
        skipped.push("Galveston (needs tbsa_burned_percent)");
        skipped.push("Mayes (needs tbsa_burned_percent)");
      } else {
        let rdaCoefficient: number | undefined;
        if (age_years < 0.5) rdaCoefficient = 108;
        else if (age_years < 1) rdaCoefficient = 98;
        else if (age_years < 3) rdaCoefficient = 102;
        else if (age_years < 10) rdaCoefficient = 90;
        else if (age_years <= 15) rdaCoefficient = 55; // source's RDA table tops out at 11-14; used for the full 4-15 Curreri Jr band
        if (rdaCoefficient !== undefined) {
          const rda = rdaCoefficient * weight_kg;
          let currBand: string, currKcalPerTbsa: number;
          if (age_years < 1) {
            currBand = "<1y";
            currKcalPerTbsa = 15;
          } else if (age_years < 3) {
            currBand = "1-3y";
            currKcalPerTbsa = 25;
          } else if (age_years <= 15) {
            currBand = "4-15y";
            currKcalPerTbsa = 40;
          } else {
            currBand = "";
            currKcalPerTbsa = 0;
          }
          if (currBand) {
            results.push({
              equation: "Curreri Junior",
              age_band: currBand,
              kcal_per_day: Math.round(rda + currKcalPerTbsa * tbsa_burned_percent),
              formula: `RDA(${rda.toFixed(0)}) + (${currKcalPerTbsa} x %TBSA burned)`,
            });
          } else {
            skipped.push("Curreri Junior (age >15y, outside source's table)");
          }
        } else {
          skipped.push("Curreri Junior (age >15y, outside source's RDA table)");
        }

        // Galveston: BSA(m2) = (4W+7)/(90+W); burned BSA = total BSA x %TBSA/100
        const bsaM2 = (4 * weight_kg + 7) / (90 + weight_kg);
        const burnedBsaM2 = bsaM2 * (tbsa_burned_percent / 100);
        let bsaCoef: number, burnCoef: number, galvestonBand: string;
        if (age_years < 1) {
          bsaCoef = 2100;
          burnCoef = 1000;
          galvestonBand = "0-1y";
        } else if (age_years <= 11) {
          bsaCoef = 1800;
          burnCoef = 1300;
          galvestonBand = "1-11y";
        } else {
          bsaCoef = 1500;
          burnCoef = 1500;
          galvestonBand = "12y+";
        }
        results.push({
          equation: "Galveston",
          age_band: galvestonBand,
          kcal_per_day: Math.round(bsaCoef * bsaM2 + burnCoef * burnedBsaM2),
          formula: `(${bsaCoef} x BSA[${bsaM2.toFixed(2)}m2]) + (${burnCoef} x burned BSA[${burnedBsaM2.toFixed(2)}m2])`,
        });

        // Mayes (source's table only covers <3 and 3-10)
        if (age_years < 3) {
          results.push({
            equation: "Mayes",
            age_band: "<3y",
            kcal_per_day: Math.round(108 + 68 * weight_kg + 3.9 * tbsa_burned_percent),
            formula: "108 + (68 x weight_kg) + (3.9 x %TBSA burned)",
          });
        } else if (age_years <= 10) {
          results.push({
            equation: "Mayes",
            age_band: "3-10y",
            kcal_per_day: Math.round(818 + 37.4 * weight_kg + 9.3 * tbsa_burned_percent),
            formula: "818 + (37.4 x weight_kg) + (9.3 x %TBSA burned)",
          });
        } else {
          skipped.push("Mayes (age >10y, outside source's table)");
        }
      }

      // Schofield (weight-only pediatric version, this source)
      if (sex === "male") {
        if (age_years < 3) results.push({ equation: "Schofield (weight-only)", age_band: "male <3y", kcal_per_day: Math.round(59.51 * weight_kg - 30.4), formula: "(59.51 x weight_kg) - 30.4" });
        else if (age_years <= 10) results.push({ equation: "Schofield (weight-only)", age_band: "male 3-10y", kcal_per_day: Math.round(22.706 * weight_kg + 504.3), formula: "(22.706 x weight_kg) + 504.3" });
        else if (age_years <= 18) results.push({ equation: "Schofield (weight-only)", age_band: "male 10-18y", kcal_per_day: Math.round(17.686 * weight_kg + 658.2), formula: "(17.686 x weight_kg) + 658.2" });
      } else {
        if (age_years < 3) results.push({ equation: "Schofield (weight-only)", age_band: "female <3y", kcal_per_day: Math.round(58.31 * weight_kg - 31.1), formula: "(58.31 x weight_kg) - 31.1" });
        else if (age_years <= 10) results.push({ equation: "Schofield (weight-only)", age_band: "female 3-10y", kcal_per_day: Math.round(20.315 * weight_kg + 485.9), formula: "(20.315 x weight_kg) + 485.9" });
        else if (age_years <= 19) results.push({ equation: "Schofield (weight-only)", age_band: "female 10-19y", kcal_per_day: Math.round(13.384 * weight_kg + 692.6), formula: "(13.384 x weight_kg) + 692.6" });
      }

      // WHO (weight-only)
      if (sex === "male") {
        if (age_years < 3) results.push({ equation: "WHO", age_band: "male 0-3y", kcal_per_day: Math.round(60.9 * weight_kg - 54), formula: "(60.9 x weight_kg) - 54" });
        else if (age_years <= 10) results.push({ equation: "WHO", age_band: "male 3-10y", kcal_per_day: Math.round(22.7 * weight_kg + 495), formula: "(22.7 x weight_kg) + 495" });
        else if (age_years <= 18) results.push({ equation: "WHO", age_band: "male 10-18y", kcal_per_day: Math.round(17.5 * weight_kg + 651), formula: "(17.5 x weight_kg) + 651" });
      } else {
        if (age_years < 3) results.push({ equation: "WHO", age_band: "female 0-3y", kcal_per_day: Math.round(61.0 * weight_kg - 51), formula: "(61.0 x weight_kg) - 51" });
        else if (age_years <= 10) results.push({ equation: "WHO", age_band: "female 3-10y", kcal_per_day: Math.round(22.5 * weight_kg + 499), formula: "(22.5 x weight_kg) + 499" });
        else if (age_years <= 18) results.push({ equation: "WHO", age_band: "female 10-18y", kcal_per_day: Math.round(12.2 * weight_kg + 746), formula: "(12.2 x weight_kg) + 746" });
      }

      return ok(
        {
          equations: results,
          skipped_or_out_of_range: skipped,
          warning:
            "Per source: ALL of these equations have historically overpredicted BMR, leading to overfeeding and complications (hyperglycemia, hepatosteatosis, hypercapnia -> ventilator dependence). Use measured REE (indirect calorimetry) to guide nutritional support whenever available, not these predictions.",
        },
        { disclaimer: PEDIATRIC_BURN_DISCLAIMER, citation: "Mrazek et al, Semin Plast Surg 2024;38:125-132, Table 1" }
      );
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
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("burn_hypermetabolism_pharmacologic_dosing", async ({ weight_kg }) => {
      const scale = (perKg: number) => (weight_kg ? Math.round(perKg * weight_kg * 100) / 100 : undefined);

      return ok(
        {
          growth_hormone_rhGH: {
            dose: "0.2 mg/kg/day, subcutaneous",
            dose_for_patient_mg_per_day: scale(0.2),
            note: "Dose is cut in half once the patient is 95% healed. Low pediatric doses have been shown safe (unlike high-dose rhGH in nonburn adult ICUs, which increased mortality).",
            side_effects: ["hypotension", "hyperglycemia (secondary to insulin resistance)"],
          },
          igf1_igfbp3: {
            dose_range: "0.5-4 mg/kg/day, continuous IV infusion",
            dose_range_for_patient_mg_per_day: weight_kg ? { low: scale(0.5), high: scale(4) } : undefined,
            main_side_effect: "hypoglycemia",
          },
          insulin: {
            dose_range: "9-10 U/hour up to a maximum of 28 U/hour, continuous infusion",
            note: "Requires concomitant 50% Dextrose (D50) infusion to maintain euglycemia. Greatest risk is hypoglycemia. Shown to promote net skeletal muscle protein synthesis and faster donor site healing.",
          },
          propranolol: {
            dose: "1 mg/kg/dose, by mouth, every 6 hours; titrated to reduce basal heart rate by 20%",
            dose_for_patient_mg_per_dose: scale(1),
            note: "May be started as early as 24 hours post-burn. Nonselective beta-blocker; decreases hyperdynamic circulation, obligatory thermogenesis, and REE.",
          },
          oxandrolone: {
            dose: "0.1 mg/kg/dose, by mouth, twice daily, given for up to 1 year post-burn",
            dose_for_patient_mg_per_dose: scale(0.1),
            note: "Synthetic testosterone analog; only ~5% androgenic effect of testosterone, so virilization is minimal. Main side effect is transaminitis, sometimes associated with hepatic failure and intra-abdominal hemorrhage.",
            REGULATORY_WARNING:
              "The FDA withdrew approval for oxandrolone (Oxandrin and generic oxandrolone tablets) on June 23, 2023, over safety concerns (Fed Regist 2023;88(123):41970-41971). This postdates the ESPEN 2013 source elsewhere in this tool set, which recommends oxandrolone without this caveat. Verify current regulatory/prescribing status before use.",
          },
        },
        { disclaimer: PEDIATRIC_BURN_DISCLAIMER, citation: "Mrazek et al, Semin Plast Surg 2024;38:125-132" }
      );
    })
  );
}
