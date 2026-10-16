import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { chakudyaClient } from "../clients/chakudyaClient.js";
import { ok, safeTool } from "../utils/toolResult.js";

/**
 * Combined WHO growth assessment (chakudya-api GET /growth/assess): one call returns every WHO
 * indicator that applies to the measurements given (length/height-for-age, weight-for-age,
 * weight-for-length/height, BMI-for-age, head-circumference-for-age, MUAC-for-age, MUAC fixed
 * cut-offs), plus an `attention` list and acute-malnutrition signals. Each indicator is the same
 * calculation as its own endpoint.
 */
export function registerGrowthAssessTools(server: McpServer) {
  server.registerTool(
    "growth_assess",
    {
      title: "Combined WHO Growth Assessment (0-19 years)",
      description:
        "Assess a child or adolescent (0-228 completed months) against every applicable WHO growth indicator in one " +
        "call, using Chakudya's WHO tables: length/height-for-age, weight-for-age, weight-for-length/height, BMI-for-age, " +
        "head-circumference-for-age, MUAC-for-age and MUAC cut-offs. Give sex, age_months and at least one measurement. " +
        "Indicators whose measurement is missing or whose age range does not apply come back under not_assessed with the " +
        "reason; 'attention' lists everything outside the normal range, most serious first. Screening aid only, not a diagnosis. " +
        "MUAC scheme defaults to CMAM (115/125 mm) for 6-59 months and WHO/FANTA otherwise.",
      inputSchema: {
        sex: z.enum(["girls", "boys"]),
        age_months: z.number().int().min(0).max(228).describe("Whole completed months, e.g. 1y 6m = 18"),
        weight_kg: z.number().positive().optional(),
        length_cm: z.number().positive().optional().describe("Recumbent length (under 2 years)"),
        height_cm: z.number().positive().optional().describe("Standing height (2 years and over)"),
        hc_cm: z.number().positive().optional().describe("Head circumference in cm"),
        muac_cm: z.number().positive().optional().describe("Mid-upper arm circumference in cm (not mm)"),
        muac_scheme: z.enum(["who_hiv_2008", "cmam"]).optional(),
        measured: z.enum(["lying", "standing"]).optional().describe("How length/height was measured, if not implied by the age"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safeTool("growth_assess", async (input) => {
      const { sex, age_months, weight_kg, length_cm, height_cm, hc_cm, muac_cm, muac_scheme, measured } = input;
      if (weight_kg === undefined && length_cm === undefined && height_cm === undefined && hc_cm === undefined && muac_cm === undefined) {
        throw new Error("Provide at least one measurement: weight_kg, length_cm/height_cm, hc_cm or muac_cm.");
      }
      const res = await chakudyaClient.get("/growth/assess", {
        sex, age_months, weight_kg, length_cm, height_cm, hc_cm, muac_cm, muac_scheme, measured,
      });
      return ok(res.data ?? res, {
        disclaimer: "Screening aid only, not a diagnosis. Interpret with the child's history, clinical signs and growth trend.",
      });
    })
  );
}
