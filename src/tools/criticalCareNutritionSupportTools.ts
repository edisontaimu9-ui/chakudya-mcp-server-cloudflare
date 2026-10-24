import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { chakudyaClient } from "../clients/chakudyaClient.js";
import { ok, safeTool } from "../utils/toolResult.js";

/**
 * Critical care / ICU nutrition support on chakudya-api (/critical-care/*): macronutrient
 * requirement references, general (non-burn) nitrogen balance, electrolyte replacement and
 * fluid requirement. The calculations and tables live in the API (src/criticalCare.js);
 * these tools only pass the inputs through, so the API is the single source of truth.
 *
 * Tools:
 *   - protein_requirement_by_stress_level   POST /critical-care/protein-by-stress
 *   - npe_nitrogen_ratio_calculator         POST /critical-care/npe-nitrogen-ratio
 *   - nitrogen_balance_calculator           POST /critical-care/nitrogen-balance  (general ICU,
 *                                           distinct from the burn-specific burn_nitrogen_balance)
 *   - carbohydrate_requirement_reference    POST /critical-care/carbohydrate
 *   - fat_requirement_reference             GET  /critical-care/fat
 *   - propofol_fat_content_calculator       POST /critical-care/propofol-fat
 *   - cho_fat_ratio_reference               GET  /critical-care/cho-fat-ratio
 *   - electrolyte_replacement_reference     POST /critical-care/electrolytes
 *   - potassium_deficit_estimator           POST /critical-care/potassium-deficit
 *   - icu_fluid_requirement_calculator      POST /critical-care/fluid
 */
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

export function registerCriticalCareNutritionSupportTools(server: McpServer) {
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
      annotations: READ,
    },
    safeTool("protein_requirement_by_stress_level", async (input) => {
      const res = await chakudyaClient.post("/critical-care/protein-by-stress", input);
      return ok(res.data ?? res);
    })
  );

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
      annotations: READ,
    },
    safeTool("npe_nitrogen_ratio_calculator", async (input) => {
      const res = await chakudyaClient.post("/critical-care/npe-nitrogen-ratio", input);
      return ok(res.data ?? res);
    })
  );

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
      annotations: READ,
    },
    safeTool("nitrogen_balance_calculator", async (input) => {
      const res = await chakudyaClient.post("/critical-care/nitrogen-balance", input);
      return ok(res.data ?? res);
    })
  );

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
      annotations: READ,
    },
    safeTool("carbohydrate_requirement_reference", async (input) => {
      const res = await chakudyaClient.post("/critical-care/carbohydrate", input);
      return ok(res.data ?? res);
    })
  );

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
      annotations: READ,
    },
    safeTool("fat_requirement_reference", async () => {
      const res = await chakudyaClient.get("/critical-care/fat");
      return ok(res.data ?? res);
    })
  );

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
      annotations: READ,
    },
    safeTool("propofol_fat_content_calculator", async (input) => {
      const res = await chakudyaClient.post("/critical-care/propofol-fat", input);
      return ok(res.data ?? res);
    })
  );

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
      annotations: READ,
    },
    safeTool("cho_fat_ratio_reference", async () => {
      const res = await chakudyaClient.get("/critical-care/cho-fat-ratio");
      return ok(res.data ?? res);
    })
  );

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
      annotations: READ,
    },
    safeTool("electrolyte_replacement_reference", async (input) => {
      const res = await chakudyaClient.post("/critical-care/electrolytes", input);
      return ok(res.data ?? res);
    })
  );

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
      annotations: READ,
    },
    safeTool("potassium_deficit_estimator", async (input) => {
      const res = await chakudyaClient.post("/critical-care/potassium-deficit", input);
      return ok(res.data ?? res);
    })
  );

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
      annotations: READ,
    },
    safeTool("icu_fluid_requirement_calculator", async (input) => {
      const res = await chakudyaClient.post("/critical-care/fluid", input);
      return ok(res.data ?? res);
    })
  );
}
