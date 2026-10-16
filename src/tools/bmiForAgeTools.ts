import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, safeTool } from "../utils/toolResult.js";
import { chakudyaClient } from "../clients/chakudyaClient.js";
import type { Severity } from "./nacsClassificationTools.js";

/**
 * BMI-for-age (5y 1m - 19y 0m) via the Chakudya API's
 * GET /bmi-for-age/classify endpoint.
 *
 * The endpoint compares a child's UNROUNDED BMI against the WHO 2007
 * BMI-for-age table as printed in the Malawi Ministry of Health guide
 * "Eat Well to Live Well" (2021), Annex 2 (one row per sex per completed
 * month, -3SD..+3SD cut-offs). Cut-offs are strict: severe thinness < -3SD,
 * thinness < -2SD, normal -2SD..+1SD, overweight > +1SD, obesity > +2SD.
 *
 * This file holds:
 *   - fetchBmiForAge(): the single place the MCP server calls that endpoint
 *     (used by the bmi_for_age_classify tool below AND by
 *     schoolAgeScreeningTools.ts, which falls back to the in-process WHO
 *     2007 LMS z-score if the call fails);
 *   - small pure helpers that map the endpoint's status vocabulary onto the
 *     NACS severity vocabulary the rest of the screening modules use.
 *
 * Screening aid only, not a diagnosis.
 */

export const BMI_FOR_AGE_MIN_MONTHS = 61; // 5y 1m — first row of the API table and of the local WHO 2007 LMS table
export const BMI_FOR_AGE_MAX_MONTHS = 228; // 19y 0m

export type BmiForAgeStatus = "severe thinness" | "thinness" | "normal" | "overweight" | "obesity";

export interface BmiForAgeApiData {
  sex: "girls" | "boys";
  age_months: number;
  status: BmiForAgeStatus;
  bmi: number; // rounded to 1 decimal by the API; the comparison itself used the unrounded value
  cutoffs: Record<string, number>; // keys: -3SD, -2SD, -1SD, median, +1SD, +2SD, +3SD
  source: string;
  note?: string;
}

export interface BmiForAgeQuery {
  sex: "male" | "female";
  /** Completed months (years x 12 + months). Must be a whole number, 61-228. */
  age_months: number;
  /** Provide bmi, or both weight_kg and height_cm (preferred: the API keeps the unrounded BMI). */
  bmi?: number;
  weight_kg?: number;
  height_cm?: number;
}

export type BmiForAgeFetcher = (query: BmiForAgeQuery) => Promise<BmiForAgeApiData>;

const VALID_STATUSES: readonly string[] = ["severe thinness", "thinness", "normal", "overweight", "obesity"];

/** Calls GET /bmi-for-age/classify. Throws ChakudyaApiError (or Error on an unexpected body) on failure. */
export const fetchBmiForAge: BmiForAgeFetcher = async (query) => {
  const useWeightHeight = query.weight_kg !== undefined && query.height_cm !== undefined;
  const res = await chakudyaClient.get<BmiForAgeApiData>("/bmi-for-age/classify", {
    sex: query.sex === "female" ? "girls" : "boys",
    age_months: query.age_months,
    // weight+height win over a pre-computed BMI so the API can compare the unrounded value
    ...(useWeightHeight
      ? { weight_kg: query.weight_kg, height_cm: query.height_cm }
      : { bmi: query.bmi }),
  });
  const data = res.data;
  if (!data || typeof data.status !== "string" || !VALID_STATUSES.includes(data.status)) {
    throw new Error("Unexpected response from /bmi-for-age/classify (missing or unknown status).");
  }
  return data;
};

/** Maps the endpoint's status vocabulary to the NACS severity vocabulary (severe/moderate/normal/overweight/obesity). */
export function bmiForAgeSeverity(status: BmiForAgeStatus): Severity {
  switch (status) {
    case "severe thinness":
      return "severe";
    case "thinness":
      return "moderate";
    case "normal":
      return "normal";
    case "overweight":
      return "overweight";
    case "obesity":
      return "obesity";
  }
}

/**
 * Maps the classification label produced by who_growth_zscore's
 * bmi_for_age_5_19y standard (see classify() in whoGrowthTools.ts) onto the
 * endpoint's status vocabulary. Same cut-offs (-3/-2/+1/+2 SD); used only
 * when the endpoint is unreachable. Returns undefined for an unknown label.
 */
export function bmiForAgeStatusFromWhoLabel(label: string): BmiForAgeStatus | undefined {
  switch (label) {
    case "severely thin":
      return "severe thinness";
    case "thin":
      return "thinness";
    case "normal":
      return "normal";
    case "overweight":
      return "overweight";
    case "obese":
      return "obesity";
    default:
      return undefined;
  }
}

export function registerBmiForAgeTools(server: McpServer): void {
  server.registerTool(
    "bmi_for_age_classify",
    {
      title: "BMI-for-age Classification (5-19 years, Chakudya API)",
      description:
        "Classify BMI-for-age for a child or adolescent from 5y 1m to 19y 0m (61-228 completed months) using the " +
        "Chakudya API's /bmi-for-age/classify endpoint: the WHO 2007 BMI-for-age table as printed in the Malawi " +
        "Ministry of Health guide 'Eat Well to Live Well' (2021), Annex 2. Returns severe thinness (< -3SD), thinness " +
        "(< -2SD), normal (-2SD to +1SD), overweight (> +1SD) or obesity (> +2SD), plus the exact -3SD..+3SD BMI " +
        "cut-offs used for that sex and age. Provide age_months plus either bmi, or weight_kg AND height_cm " +
        "(preferred — the unrounded BMI is compared). For a z-score/percentile use who_growth_zscore with " +
        "standard bmi_for_age_5_19y; for a full screening workflow (MUAC, oedema, referral action) use " +
        "school_age_integrated_screen. Screening aid only, not a diagnosis.",
      inputSchema: {
        sex: z.enum(["male", "female"]),
        age_months: z
          .number()
          .int()
          .min(BMI_FOR_AGE_MIN_MONTHS)
          .max(BMI_FOR_AGE_MAX_MONTHS)
          .describe("Completed months = years x 12 + months (e.g. 7y 11m = 95). 61-228."),
        bmi: z.number().positive().optional().describe("BMI in kg/m^2. Omit if weight_kg and height_cm are given."),
        weight_kg: z.number().positive().optional(),
        height_cm: z.number().positive().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safeTool("bmi_for_age_classify", async ({ sex, age_months, bmi, weight_kg, height_cm }) => {
      const hasWeightHeight = weight_kg !== undefined && height_cm !== undefined;
      if (!hasWeightHeight && bmi === undefined) {
        throw new Error("Provide bmi, or both weight_kg and height_cm.");
      }
      const data = await fetchBmiForAge({ sex, age_months, bmi, weight_kg, height_cm });
      return ok(data, {
        disclaimer:
          "Screening aid only, not a diagnosis. Classification from the Chakudya API /bmi-for-age/classify " +
          "(WHO 2007 BMI-for-age, as printed in Malawi MoH 'Eat Well to Live Well' 2021, Annex 2).",
      });
    })
  );
}
