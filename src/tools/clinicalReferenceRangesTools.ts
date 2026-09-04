import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, safeTool } from "../utils/toolResult.js";

/**
 * Reference values for arterial blood gases and other clinical ranges, as
 * compiled in a hospital dietetics ICU nutrition support guideline (used to
 * interpret respiratory/metabolic status alongside nutrition assessment —
 * e.g. informing CHO:fat ratio choice via cho_fat_ratio_reference).
 *
 * Pure reference lookup — no Chakudya API calls.
 *
 * One tool: clinical_reference_ranges
 */

const CRR_DISCLAIMER =
  "Reference ranges only, from a hospital dietetics ICU nutrition support guideline. Not a substitute " +
  "for institutional lab reference ranges or clinical judgment.";

const CLINICAL_REFERENCE_RANGES = {
  arterial_blood_gas: {
    pH: "7.35 - 7.45",
    pCO2_kPa: "4.6 - 6",
    pO2_kPa: "11 - 13",
    base_excess: "-2 to +2",
    HCO3_mmol_l: "22 - 26",
  },
  intra_abdominal_pressure: {
    normal_mmHg: "5 - 7",
    reduced_organ_perfusion_mmHg: "10 - 15",
  },
  intracranial_pressure_mmHg: "5 - 15",
  lactate_mmol_l: {
    normal: "0.5 - 1.0",
    icu: "1.0 - 2.0",
  },
};

export function registerClinicalReferenceRangesTools(server: McpServer) {
  server.registerTool(
    "clinical_reference_ranges",
    {
      title: "Clinical Reference Ranges (ABG, IAP, ICP, Lactate)",
      description:
        "Look up reference ranges for arterial blood gases (pH, pCO2, pO2, base excess, HCO3), " +
        "intra-abdominal pressure (normal and reduced-organ-perfusion), intracranial pressure, and " +
        "lactate (normal and ICU). Provide a category to get just that one, or omit to return all.",
      inputSchema: {
        category: z.enum(["arterial_blood_gas", "intra_abdominal_pressure", "intracranial_pressure", "lactate"]).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("clinical_reference_ranges", async ({ category }) => {
      if (category === undefined) {
        return ok(CLINICAL_REFERENCE_RANGES, { disclaimer: CRR_DISCLAIMER });
      }
      const map: Record<string, unknown> = {
        arterial_blood_gas: CLINICAL_REFERENCE_RANGES.arterial_blood_gas,
        intra_abdominal_pressure: CLINICAL_REFERENCE_RANGES.intra_abdominal_pressure,
        intracranial_pressure: { intracranial_pressure_mmHg: CLINICAL_REFERENCE_RANGES.intracranial_pressure_mmHg },
        lactate: CLINICAL_REFERENCE_RANGES.lactate_mmol_l,
      };
      return ok({ [category]: map[category] }, { disclaimer: CRR_DISCLAIMER });
    })
  );
}
