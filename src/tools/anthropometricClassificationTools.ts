import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, safeTool } from "../utils/toolResult.js";

/**
 * Part B: Assessment of the Anthropometric Status of the Hospitalized
 * Patient — Section 3.4 (BMI classification, waist circumference) and
 * Section 3.5 (Upper Arm Anthropometry / MUAC), as compiled in a hospital
 * dietetics anthropometry guideline.
 *
 * Sources:
 *  - BMI: WHO 2000 (Obesity: preventing and managing the global epidemic);
 *    WHO Global Database on BMI; and Malawi NCST Guidelines 2015.
 *  - Waist circumference: unattributed action-level table in the source guide.
 *  - MUAC: CMAM Guidelines 2017 (single cut-off) — a DISTINCT source from
 *    the NACS User's Guide Module 2 cutoffs already in nacsClassificationTools.ts;
 *    the two overlap in places (e.g. 6-59 months) but are not identical and
 *    are kept as separate tools rather than merged.
 *
 * Pure table lookup / classification — no Chakudya API calls. Educational/
 * clinical-support only, not a substitute for a full clinical nutrition
 * assessment.
 *
 * Three tools:
 *   - bmi_classification
 *   - waist_circumference_interpretation
 *   - muac_cutoff_cmam_2017
 */

const AC_DISCLAIMER =
  "Classification/reference only, per the cited source tables. Not a substitute for a full clinical " +
  "nutrition assessment.";

function err(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

export function registerAnthropometricClassificationTools(server: McpServer) {
  // ── bmi_classification ────────────────────────────────────────────────────
  server.registerTool(
    "bmi_classification",
    {
      title: "BMI Classification (WHO 2000 & NCST 2015)",
      description:
        "Classify BMI (kg/m2) against two source tables: the WHO (2000) classification with comorbidity " +
        "risk band (severe/moderate/mild thinness, underweight, normal, overweight, pre-obese, obese " +
        "class 1-3), and the Malawi NCST Guidelines (2015) nutritional status classification (normal, " +
        "moderate/severe acute malnutrition, overweight, obese). Both are returned for the same bmi value " +
        "since they use different bands. Provide weight_kg and height_cm instead of bmi to have BMI " +
        "computed for you.",
      inputSchema: {
        bmi: z.number().positive().optional().describe("BMI in kg/m2. Omit if providing weight_kg + height_cm instead."),
        weight_kg: z.number().positive().optional(),
        height_cm: z.number().positive().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("bmi_classification", async ({ bmi, weight_kg, height_cm }) => {
      let resolvedBmi = bmi;
      if (resolvedBmi === undefined) {
        if (weight_kg === undefined || height_cm === undefined) {
          return err("Provide either bmi, or both weight_kg and height_cm.");
        }
        const heightM = height_cm / 100;
        resolvedBmi = weight_kg / (heightM * heightM);
      }

      let whoClassification: string;
      let whoRisk: string;
      if (resolvedBmi < 16.0) { whoClassification = "Severe thinness"; whoRisk = "Low risk"; }
      else if (resolvedBmi < 17.0) { whoClassification = "Moderate thinness"; whoRisk = "Low risk"; }
      else if (resolvedBmi < 18.5) { whoClassification = "Mild thinness"; whoRisk = "Low risk"; }
      else if (resolvedBmi < 25.0) { whoClassification = "Normal"; whoRisk = "Average risk"; }
      else if (resolvedBmi < 30.0) { whoClassification = "Pre-obese"; whoRisk = "Increased risk"; }
      else if (resolvedBmi < 35.0) { whoClassification = "Obese class 1"; whoRisk = "Moderate risk"; }
      else if (resolvedBmi < 40.0) { whoClassification = "Obese class 2"; whoRisk = "Severe risk"; }
      else { whoClassification = "Obese class 3"; whoRisk = "Very severe risk"; }

      let ncstClassification: string;
      if (resolvedBmi < 16.0) ncstClassification = "Severe acute malnutrition (SAM) — check for medical complications";
      else if (resolvedBmi < 18.5) ncstClassification = "Moderate acute malnutrition (MAM)";
      else if (resolvedBmi <= 25.0) ncstClassification = "Normal";
      else if (resolvedBmi < 30.0) ncstClassification = "Overweight";
      else ncstClassification = "Obese";

      return ok(
        {
          bmi: Math.round(resolvedBmi * 10) / 10,
          who_2000: { classification: whoClassification, risk_of_comorbidities: whoRisk },
          ncst_2015: { classification: ncstClassification },
        },
        { disclaimer: AC_DISCLAIMER, citation: "WHO 2000 Technical Report Series 894; WHO Global Database on BMI; Malawi NCST Guidelines 2015" }
      );
    })
  );

  // ── waist_circumference_interpretation ────────────────────────────────────
  server.registerTool(
    "waist_circumference_interpretation",
    {
      title: "Waist Circumference Interpretation",
      description:
        "Interpret waist circumference action level by sex: Action level 1 (males <94cm, females <80cm) — " +
        "no action; Action level 2 (males 94-101.9cm, females 80-87.9cm) — 'be aware of risk'/'avoid weight " +
        "gain'; Action level 3 (males >102cm, females >88cm) — 'seek advice'/'lose or maintain weight'.",
      inputSchema: {
        sex: z.enum(["male", "female"]),
        waist_circumference_cm: z.number().positive(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("waist_circumference_interpretation", async ({ sex, waist_circumference_cm }) => {
      let actionLevel: number;
      let advice: string;
      if (sex === "male") {
        if (waist_circumference_cm < 94) { actionLevel = 1; advice = "No action"; }
        else if (waist_circumference_cm <= 101.9) { actionLevel = 2; advice = "'Be aware of risk' / 'avoid weight gain'"; }
        else { actionLevel = 3; advice = "'Seek advice' / 'lose or maintain weight'"; }
      } else {
        if (waist_circumference_cm < 80) { actionLevel = 1; advice = "No action"; }
        else if (waist_circumference_cm <= 87.9) { actionLevel = 2; advice = "'Be aware of risk' / 'avoid weight gain'"; }
        else { actionLevel = 3; advice = "'Seek advice' / 'lose or maintain weight'"; }
      }
      return ok(
        { sex, waist_circumference_cm, action_level: actionLevel, advice },
        { disclaimer: AC_DISCLAIMER }
      );
    })
  );

  // ── muac_cutoff_cmam_2017 ─────────────────────────────────────────────────
  server.registerTool(
    "muac_cutoff_cmam_2017",
    {
      title: "MUAC Single Cut-off Classification (CMAM Guidelines, 2017)",
      description:
        "Classify wasting from MUAC using the CMAM Guidelines (2017) single-cutoff table by age/status " +
        "group: 6-59 months (<11.5cm severe / 11.5-12.5cm moderate / >=12.5cm no wasting); 5-9 years " +
        "(<13.0cm / 13-14.5cm / >=14.5cm); 10-15 years (<16cm / 16-18.5cm / >=18.5cm); adults (<19cm / " +
        "19-21.9cm / >22cm); pregnant & lactating women up to 6 months post-partum (<19cm / 19-23cm / " +
        ">23cm). This is a DISTINCT source from the NACS User's Guide Module 2 MUAC cutoffs used " +
        "elsewhere in this tool set — the two overlap in places but are not identical; don't mix results " +
        "from the two sources for the same patient without noting which guideline is being followed.",
      inputSchema: {
        age_group: z.enum(["6_59_months", "5_9_years", "10_15_years", "adult", "pregnant_lactating"]),
        muac_cm: z.number().positive(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("muac_cutoff_cmam_2017", async ({ age_group, muac_cm }) => {
      const bands: Record<string, { severe: number; moderateHigh: number; label: string }> = {
        "6_59_months": { severe: 11.5, moderateHigh: 12.5, label: "6-59 months" },
        "5_9_years": { severe: 13.0, moderateHigh: 14.5, label: "5-9 years" },
        "10_15_years": { severe: 16.0, moderateHigh: 18.5, label: "10-15 years" },
        adult: { severe: 19.0, moderateHigh: 21.9, label: "Adults" },
        pregnant_lactating: { severe: 19.0, moderateHigh: 23.0, label: "Pregnant & lactating women (up to 6 months post-partum)" },
      };
      const band = bands[age_group];
      let classification: string;
      if (muac_cm < band.severe) classification = "Severe wasting";
      else if (muac_cm <= band.moderateHigh) classification = "Moderate wasting";
      else classification = "No wasting";

      return ok(
        { age_group: band.label, muac_cm, classification },
        { disclaimer: AC_DISCLAIMER, citation: "CMAM Guidelines, 2017" }
      );
    })
  );
}
