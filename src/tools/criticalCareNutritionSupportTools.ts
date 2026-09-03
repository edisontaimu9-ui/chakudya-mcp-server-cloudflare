import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, safeTool } from "../utils/toolResult.js";

/**
 * Critical care / ICU macronutrient requirement estimation, general (non-burn)
 * nitrogen balance, electrolyte replacement, and fluid requirement reference,
 * as compiled in a hospital dietetics guideline (sections 2-6: "Estimation of
 * protein requirements", "Estimation of carbohydrate requirements",
 * "Estimation of fat requirements", "Micronutrients", "Electrolyte
 * supplementation", "Fluid requirements").
 *
 * Pure calculation / reference lookup — no Chakudya API calls.
 *
 * Tools:
 *   - protein_requirement_by_stress_level
 *   - npe_nitrogen_ratio_calculator
 *   - nitrogen_balance_calculator          (general ICU — distinct from the
 *                                            burn-specific burn_nitrogen_balance)
 *   - carbohydrate_requirement_reference
 *   - fat_requirement_reference
 *   - propofol_fat_content_calculator
 *   - cho_fat_ratio_reference
 *   - electrolyte_replacement_reference
 *   - potassium_deficit_estimator
 *   - icu_fluid_requirement_calculator
 */

const CCNS_DISCLAIMER =
  "Reference/estimate only, from a hospital dietetics ICU nutrition support guideline. Individualize to " +
  "the patient — hydration status, organ function, and losses from wounds/stoma/fistula are not captured " +
  "by these formulas. Not a substitute for individualized clinical assessment or institutional protocol.";

function err(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

// ── 2.1 Protein requirement by stress level ─────────────────────────────────
interface ProteinStressRow {
  stress_level: number;
  label: string;
  protein_g_per_kg_low: number;
  protein_g_per_kg_high: number;
  protein_g_per_kg_range: string;
}

const PROTEIN_STRESS_TABLE: ProteinStressRow[] = [
  { stress_level: 0, label: "Normal", protein_g_per_kg_low: 0.8, protein_g_per_kg_high: 0.8, protein_g_per_kg_range: "0.8 g/kg" },
  { stress_level: 1, label: "Mild", protein_g_per_kg_low: 0.8, protein_g_per_kg_high: 1, protein_g_per_kg_range: "0.8 - 1 g/kg" },
  { stress_level: 2, label: "Moderate", protein_g_per_kg_low: 1.2, protein_g_per_kg_high: 1.5, protein_g_per_kg_range: "1.2 - 1.5 g/kg" },
  { stress_level: 3, label: "Severe", protein_g_per_kg_low: 1.6, protein_g_per_kg_high: 2.5, protein_g_per_kg_range: "1.6 - 2.5 g/kg" },
];

// ── 2.2 Interpretation table: urinary N2 (g/24h) → stress → protein g/kg ────
// Distinct source table from PROTEIN_STRESS_TABLE above — note its "Severe"
// protein range (1.9-2.5 g/kg) differs slightly from the 2.1 table's
// (1.6-2.5 g/kg); both are reproduced as printed rather than reconciled.
interface UrinaryN2Row {
  urinary_n2_g_per_24h_range: string;
  stress_level: number;
  label: string;
  protein_g_per_kg_range: string;
}

const URINARY_N2_INTERPRETATION_TABLE: UrinaryN2Row[] = [
  { urinary_n2_g_per_24h_range: "< 5", stress_level: 0, label: "Normal", protein_g_per_kg_range: "0.8 g/kg" },
  { urinary_n2_g_per_24h_range: "5 - 10", stress_level: 1, label: "Mild", protein_g_per_kg_range: "0.8 - 1 g/kg" },
  { urinary_n2_g_per_24h_range: "10 - 15", stress_level: 2, label: "Moderate", protein_g_per_kg_range: "1.2 - 1.5 g/kg" },
  { urinary_n2_g_per_24h_range: "> 15", stress_level: 3, label: "Severe", protein_g_per_kg_range: "1.9 - 2.5 g/kg" },
];

// ── NPE:N2 ratio interpretation ─────────────────────────────────────────────
function interpretNpeN2Ratio(ratio: number): string {
  if (ratio > 150) return "Normal / mildly elevated";
  if (ratio >= 100) return "Moderate stress";
  if (ratio >= 80) return "Severe stress";
  return "Below the charted range (<80:1) — very severe stress, not covered by the source table";
}

export function registerCriticalCareNutritionSupportTools(server: McpServer) {
  // ── protein_requirement_by_stress_level ───────────────────────────────────
  server.registerTool(
    "protein_requirement_by_stress_level",
    {
      title: "Protein Requirement by Stress Level",
      description:
        "Look up g/kg/day protein requirement by degree of metabolic stress (0=Normal, 1=Mild, 2=Moderate, " +
        "3=Severe). Compensate separately for losses from wounds/stoma/fistula, and note protein is not " +
        "often given above 16g N (100g protein)/day except in catabolic critical illness. Provide weight_kg " +
        "to also get the g/day range. To grade stress from a 24h urinary nitrogen result instead, use " +
        "nitrogen_balance_calculator.",
      inputSchema: {
        stress_level: z.number().int().min(0).max(3).optional().describe("0-3. Omit to return the full table."),
        weight_kg: z.number().positive().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("protein_requirement_by_stress_level", async ({ stress_level, weight_kg }) => {
      const withGPerDay = (row: ProteinStressRow) => ({
        ...row,
        protein_g_per_day_low: weight_kg !== undefined ? Math.round(row.protein_g_per_kg_low * weight_kg * 10) / 10 : undefined,
        protein_g_per_day_high: weight_kg !== undefined ? Math.round(row.protein_g_per_kg_high * weight_kg * 10) / 10 : undefined,
      });

      if (stress_level !== undefined) {
        const row = PROTEIN_STRESS_TABLE.find((r) => r.stress_level === stress_level);
        if (!row) return err(`Invalid stress_level "${stress_level}". Must be 0-3.`);
        return ok(withGPerDay(row), {
          disclaimer: CCNS_DISCLAIMER,
          note: "Not often > 16g N (100g protein)/day except in catabolic critical illness.",
        });
      }
      return ok(
        { stress_levels: PROTEIN_STRESS_TABLE.map(withGPerDay) },
        { disclaimer: CCNS_DISCLAIMER, note: "Not often > 16g N (100g protein)/day except in catabolic critical illness." }
      );
    })
  );

  // ── npe_nitrogen_ratio_calculator ─────────────────────────────────────────
  server.registerTool(
    "npe_nitrogen_ratio_calculator",
    {
      title: "NPE:Nitrogen Ratio Calculator",
      description:
        "Calculate the non-protein-energy to nitrogen (NPE:N2) ratio (g protein / 6.25 = g N2; ratio = " +
        "NPE kcal / g N2) and interpret degree of metabolic stress: >150:1 normal/mildly elevated, " +
        "100-150:1 moderate stress, 80-100:1 severe stress.",
      inputSchema: {
        npe_kcal: z.number().positive().describe("Non-protein energy, kcal/24h"),
        protein_g: z.number().positive().describe("Protein intake, g/24h"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("npe_nitrogen_ratio_calculator", async ({ npe_kcal, protein_g }) => {
      const nitrogenG = protein_g / 6.25;
      const ratio = npe_kcal / nitrogenG;
      return ok(
        {
          npe_kcal,
          protein_g,
          nitrogen_g: Math.round(nitrogenG * 100) / 100,
          npe_to_n2_ratio: `${Math.round(ratio)}:1`,
          interpretation: interpretNpeN2Ratio(ratio),
          formula: "g N2 = g protein / 6.25; ratio = NPE kcal / g N2",
        },
        { disclaimer: CCNS_DISCLAIMER }
      );
    })
  );

  // ── nitrogen_balance_calculator (general ICU) ─────────────────────────────
  server.registerTool(
    "nitrogen_balance_calculator",
    {
      title: "Nitrogen Balance Calculator (General ICU)",
      description:
        "Calculate 24h urinary nitrogen, total urinary nitrogen, and total nitrogen output from urine " +
        "volume and urinary urea, then grade degree of metabolic stress against the urinary-N2 " +
        "interpretation table. Formulas: Urinary Nitrogen = urine_volume_L x urinary_urea_mmol_L x 0.028 " +
        "(represents only the nitrogen derived from urea); Total Urinary Nitrogen = Urinary Nitrogen x 1.2 " +
        "(theoretically accounts for all sources of urinary nitrogen); Total Nitrogen Output = Total " +
        "Urinary Nitrogen + 4g/24h obligatory losses. May be inaccurate in unstable patients — affected by " +
        "changes in hydration status, impaired liver/renal function, GI haemorrhage, and catabolic critical " +
        "illness; does not account for losses from wounds/fistulae. This is distinct from " +
        "burn_nitrogen_balance, which uses a different (UUN-based) formula for burn patients.",
      inputSchema: {
        urine_volume_l: z.number().positive().describe("24-hour urine volume, litres"),
        urinary_urea_mmol_l: z.number().nonnegative().describe("Urinary urea concentration, mmol/L"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("nitrogen_balance_calculator", async ({ urine_volume_l, urinary_urea_mmol_l }) => {
      const urinaryNitrogenG = urine_volume_l * urinary_urea_mmol_l * 0.028;
      const totalUrinaryNitrogenG = urinaryNitrogenG * 1.2;
      const totalNitrogenOutputG = totalUrinaryNitrogenG + 4;

      const band = URINARY_N2_INTERPRETATION_TABLE.find((row) => {
        if (row.urinary_n2_g_per_24h_range === "< 5") return totalNitrogenOutputG < 5;
        if (row.urinary_n2_g_per_24h_range === "5 - 10") return totalNitrogenOutputG >= 5 && totalNitrogenOutputG <= 10;
        if (row.urinary_n2_g_per_24h_range === "10 - 15") return totalNitrogenOutputG > 10 && totalNitrogenOutputG <= 15;
        return totalNitrogenOutputG > 15;
      });

      return ok(
        {
          urine_volume_l,
          urinary_urea_mmol_l,
          urinary_nitrogen_g: Math.round(urinaryNitrogenG * 100) / 100,
          total_urinary_nitrogen_g_per_24h: Math.round(totalUrinaryNitrogenG * 100) / 100,
          total_nitrogen_output_g_per_24h: Math.round(totalNitrogenOutputG * 100) / 100,
          formulas: {
            urinary_nitrogen: "urine_volume_L x urinary_urea_mmol_L x 0.028 = g N (urea-derived only)",
            total_urinary_nitrogen: "urinary_nitrogen_g x 1.2 = g N/24h",
            total_nitrogen_output: "total_urinary_nitrogen_g + 4g N/24h obligatory losses",
          },
          interpretation: band
            ? { stress_level: band.stress_level, label: band.label, protein_g_per_kg_range: band.protein_g_per_kg_range }
            : undefined,
          caution:
            "May be inaccurate in unstable patients: affected by changes in hydration status, impaired " +
            "liver and renal function, gastrointestinal haemorrhage, and catabolic critical illness. Does " +
            "not account for losses from wounds/fistulae.",
        },
        { disclaimer: CCNS_DISCLAIMER }
      );
    })
  );

  // ── carbohydrate_requirement_reference ────────────────────────────────────
  server.registerTool(
    "carbohydrate_requirement_reference",
    {
      title: "Carbohydrate Requirement Reference",
      description:
        "Reference values for estimating carbohydrate requirements: usual = 60-70% of NPE OR 30-70% of " +
        "total energy OR 2-4 mg/kg/min OR 3-5 g/kg/min; minimum = 150-200 g/24h; maximum = 6-7 mg/kg/min in " +
        "the absence of metabolic stress, 4-5 mg/kg/min in severe stress (7.2 g/kg/day), 4-5 mg/kg/min for " +
        "TPN. Provide weight_kg to also compute g/day from the mg/kg/min bounds.",
      inputSchema: {
        weight_kg: z.number().positive().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("carbohydrate_requirement_reference", async ({ weight_kg }) => {
      const mgKgMinToGPerDay = (mgPerKgMin: number) =>
        weight_kg !== undefined ? Math.round(mgPerKgMin * weight_kg * 1.44 * 10) / 10 : undefined;

      return ok(
        {
          usual_requirements: {
            text: "60-70% of NPE OR 30-70% of total energy OR 2-4 mg/kg/min OR 3-5 g/kg/min",
            usual_low_g_per_day: mgKgMinToGPerDay(2),
            usual_high_g_per_day: mgKgMinToGPerDay(4),
          },
          minimum_requirements: { text: "150 - 200 g/24h" },
          maximum_recommendations: {
            no_metabolic_stress: { text: "6-7 mg/kg/min", g_per_day: mgKgMinToGPerDay(6.5) },
            severe_stress: { text: "4-5 mg/kg/min (7.2 g/kg/day)", g_per_day: mgKgMinToGPerDay(4.5) },
            tpn: { text: "4-5 mg/kg/min", g_per_day: mgKgMinToGPerDay(4.5) },
          },
          note: "mg/kg/min -> g/day conversion: mg/kg/min x weight_kg x 1440 min/day / 1000 mg/g.",
          consider: "Other sources of glucose, e.g. glucose administration in intravenous fluids.",
        },
        { disclaimer: CCNS_DISCLAIMER }
      );
    })
  );

  // ── fat_requirement_reference ─────────────────────────────────────────────
  server.registerTool(
    "fat_requirement_reference",
    {
      title: "Fat Requirement Reference",
      description:
        "Reference values for estimating fat requirements: usual = 30-40% of non-protein energy; minimum = " +
        "100-200 g/week (absolute minimum for providing essential fatty acids); maximum = 1-2 g/kg/day " +
        "(considered safe, ESPEN 2009). In acute pancreatitis: give 0.8-1.5 g/kg fat via TPN and keep serum " +
        "triglycerides <12 mmol/L. Also consider other IV fat sources, e.g. propofol (see " +
        "propofol_fat_content_calculator).",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("fat_requirement_reference", async () => {
      return ok(
        {
          usual_requirements: "30 - 40% of non-protein energy",
          minimum_requirements: "100 - 200 g/week, absolute minimum for providing essential fatty acids (EFAs)",
          maximum_recommendations: "1-2 g/kg/day is considered safe (ESPEN 2009)",
          acute_pancreatitis: "Give 0.8-1.5 g/kg fat via TPN and keep serum triglycerides <12 mmol/L.",
          other_iv_fat_sources: "Consider other sources of intravenous fat, e.g. propofol administered in a fat emulsion — see propofol_fat_content_calculator.",
        },
        { disclaimer: CCNS_DISCLAIMER }
      );
    })
  );

  // ── propofol_fat_content_calculator ───────────────────────────────────────
  server.registerTool(
    "propofol_fat_content_calculator",
    {
      title: "Propofol Fat Content Calculator",
      description:
        "Calculate propofol dose and the fat delivered via its lipid emulsion carrier. 1 mL of Propofol 1% " +
        "contains 10 mg propofol and 0.1 g fat; 1 mL of Propofol 2% contains 20 mg propofol and 0.1 g fat.",
      inputSchema: {
        propofol_percent: z.enum(["1", "2"]).describe("Propofol concentration: '1' for 1%, '2' for 2%"),
        volume_ml: z.number().positive(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("propofol_fat_content_calculator", async ({ propofol_percent, volume_ml }) => {
      const propofolMgPerMl = propofol_percent === "1" ? 10 : 20;
      const fatGPerMl = 0.1;
      return ok(
        {
          propofol_percent: `${propofol_percent}%`,
          volume_ml,
          propofol_mg_total: Math.round(propofolMgPerMl * volume_ml * 10) / 10,
          fat_g_total: Math.round(fatGPerMl * volume_ml * 100) / 100,
          basis: `1 mL of Propofol ${propofol_percent}% contains ${propofolMgPerMl} mg propofol and 0.1 g fat`,
        },
        { disclaimer: CCNS_DISCLAIMER }
      );
    })
  );

  // ── cho_fat_ratio_reference ───────────────────────────────────────────────
  server.registerTool(
    "cho_fat_ratio_reference",
    {
      title: "CHO:Fat Ratio Reference",
      description:
        "Reference table for carbohydrate:fat ratios as a percent of non-protein energy (NPE): 70:30 for " +
        "normal requirements; 60:40 for glucose intolerance (blood glucose >10 mmol/L); 50:50 for a patient " +
        "difficult to wean off the ventilator, or respiratory failure (i.e. high pCO2). Also consider other " +
        "sources of glucose, e.g. glucose administration in intravenous fluids.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("cho_fat_ratio_reference", async () => {
      return ok(
        {
          ratios: [
            { cho_fat_npe_ratio: "70:30", indication: "Normal requirements" },
            { cho_fat_npe_ratio: "60:40", indication: "Glucose intolerance — blood glucose level >10 mmol/L" },
            { cho_fat_npe_ratio: "50:50", indication: "Patient difficult to wean off the ventilator, or respiratory failure (i.e. high pCO2)" },
          ],
          consider: "Other sources of glucose, e.g. glucose administration in intravenous fluids.",
        },
        { disclaimer: CCNS_DISCLAIMER }
      );
    })
  );

  // ── electrolyte_replacement_reference ─────────────────────────────────────
  server.registerTool(
    "electrolyte_replacement_reference",
    {
      title: "Electrolyte Replacement Reference",
      description:
        "Reference dosing for phosphate, potassium, and magnesium replacement. Phosphate: supplement " +
        "1-2 mg daily = 50 mmol/24h, or 0.08 mmol/kg over 8h, or 15 mmol NaPO4 over 2h for rapid " +
        "replacement. Potassium: 20-80 mmol at 10 mmol/hr via peripheral line or 20 mmol/hr via central " +
        "line; expect serum K to rise by 0.25 mmol/L for each 20 mmol KCl infused IV. Magnesium: 1-2 g " +
        "MgSO4 — e.g. 2g over 4h, or 0.5 mmol/kg/day. For an estimate of total potassium deficit from a " +
        "serum potassium level, use potassium_deficit_estimator.",
      inputSchema: {
        electrolyte: z.enum(["phosphate", "potassium", "magnesium"]).optional().describe("Omit to return all three."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("electrolyte_replacement_reference", async ({ electrolyte }) => {
      const table = {
        phosphate: {
          dosing: "Supplement 1-2 mg daily = 50 mmol/24h, or 0.08 mmol/kg over 8h",
          rapid_replacement: "15 mmol NaPO4 over 2h",
        },
        potassium: {
          dosing: "20-80 mmol at 10 mmol/hr via peripheral line, or 20 mmol/hr via central line",
          expected_rise: "Expect serum K to rise by 0.25 mmol/L for each 20 mmol KCl infused IV",
          deficit_estimation: "See potassium_deficit_estimator (serum K 3-4 ≈ 100-200 mmol deficit; serum K 2-3 ≈ 200-400 mmol deficit)",
        },
        magnesium: {
          dosing: "1-2 g MgSO4, e.g. 2g over 4h, or 0.5 mmol/kg/day",
        },
      };
      if (electrolyte !== undefined) {
        return ok({ electrolyte, ...table[electrolyte] }, { disclaimer: CCNS_DISCLAIMER });
      }
      return ok(table, { disclaimer: CCNS_DISCLAIMER });
    })
  );

  // ── potassium_deficit_estimator ───────────────────────────────────────────
  server.registerTool(
    "potassium_deficit_estimator",
    {
      title: "Potassium Deficit Estimator",
      description:
        "Estimate total body potassium deficit band from a serum potassium level: serum K of 3-4 mmol/L " +
        "reflects a 100-200 mmol K deficit; serum K of 2-3 mmol/L reflects a 200-400 mmol K deficit. Also " +
        "returns the expected serum K rise of 0.25 mmol/L for each 20 mmol KCl infused IV, for planning " +
        "replacement.",
      inputSchema: {
        serum_k_mmol_l: z.number().positive(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("potassium_deficit_estimator", async ({ serum_k_mmol_l }) => {
      let deficitBand: string | undefined;
      if (serum_k_mmol_l >= 3 && serum_k_mmol_l < 4) {
        deficitBand = "100-200 mmol K deficit";
      } else if (serum_k_mmol_l >= 2 && serum_k_mmol_l < 3) {
        deficitBand = "200-400 mmol K deficit";
      }
      return ok(
        {
          serum_k_mmol_l,
          estimated_deficit: deficitBand ?? "Outside the charted bands (2-4 mmol/L) — use clinical judgment",
          expected_rise_per_20mmol_kcl_iv: "0.25 mmol/L",
          replacement_rate: "20-80 mmol at 10 mmol/hr via peripheral line, or 20 mmol/hr via central line",
        },
        { disclaimer: CCNS_DISCLAIMER }
      );
    })
  );

  // ── icu_fluid_requirement_calculator ──────────────────────────────────────
  server.registerTool(
    "icu_fluid_requirement_calculator",
    {
      title: "ICU Fluid Requirement Calculator",
      description:
        "Estimate normal adult fluid requirements at 30-35 mL/kg/day. In the ICU, fluid requirements are " +
        "normally determined by the treating doctor — this is a reference estimate only, not a prescription.",
      inputSchema: {
        weight_kg: z.number().positive(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("icu_fluid_requirement_calculator", async ({ weight_kg }) => {
      return ok(
        {
          weight_kg,
          fluid_ml_per_day_low: Math.round(30 * weight_kg),
          fluid_ml_per_day_high: Math.round(35 * weight_kg),
          basis: "30-35 mL/kg (normal adult requirements)",
          note: "In the intensive care unit, fluid requirements are normally determined by the treating doctor.",
        },
        { disclaimer: CCNS_DISCLAIMER }
      );
    })
  );
}
