import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, safeTool } from "../utils/toolResult.js";

/**
 * Part B: Assessment of the Anthropometric Status of the Hospitalized
 * Patient — Section 2: Estimating Body Weight, from knee height & mid-arm
 * circumference (Lee & Nieman) and, for persons 65 years and older, from
 * mid-(upper-)arm circumference, calf circumference, subscapular skinfold,
 * and/or knee height (Lee & Nieman), as compiled in a hospital dietetics
 * anthropometry guideline.
 *
 * Pure calculation — no Chakudya API calls. Used when a patient cannot be
 * weighed directly.
 *
 * Two tools:
 *   - weight_from_knee_height_and_mac        (all ages, race/sex/age-specific)
 *   - weight_estimate_persons_65_and_older   (uses whichever of MUAC/CC/SSF/KH are available)
 */

const WEIGHT_ESTIMATE_DISCLAIMER =
  "Estimate only, from published predictive equations for estimating body weight when direct weighing " +
  "isn't possible. Each equation carries its own standard error of the estimate (SEE) — treat the result " +
  "as an estimate band, not an exact weight. Not a substitute for direct measurement when it is obtainable.";

function err(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

// ── 2.1 Weight from knee height & MAC (Lee & Nieman) ────────────────────────
type Race = "black" | "white";
type Sex = "male" | "female";

interface KneeHeightMacRow {
  sex: Sex;
  race: Race;
  age_band: string;
  age_min: number;
  age_max: number;
  kh_coef: number;
  mac_coef: number;
  constant: number;
  formula: string;
  see_kg: number;
}

const KNEE_HEIGHT_MAC_TABLE: KneeHeightMacRow[] = [
  { sex: "female", race: "black", age_band: "6-18", age_min: 6, age_max: 18, kh_coef: 0.71, mac_coef: 2.59, constant: -50.43, formula: "(KH x 0.71) + (MAC x 2.59) - 50.43", see_kg: 7.65 },
  { sex: "female", race: "white", age_band: "6-18", age_min: 6, age_max: 18, kh_coef: 0.77, mac_coef: 2.47, constant: -50.16, formula: "(KH x 0.77) + (MAC x 2.47) - 50.16", see_kg: 7.2 },
  { sex: "female", race: "black", age_band: "19-59", age_min: 19, age_max: 59, kh_coef: 1.24, mac_coef: 2.97, constant: -82.48, formula: "(KH x 1.24) + (MAC x 2.97) - 82.48", see_kg: 11.98 },
  { sex: "female", race: "white", age_band: "19-59", age_min: 19, age_max: 59, kh_coef: 1.01, mac_coef: 2.81, constant: -66.04, formula: "(KH x 1.01) + (MAC x 2.81) - 66.04", see_kg: 10.6 },
  { sex: "female", race: "black", age_band: "60-80", age_min: 60, age_max: 80, kh_coef: 1.5, mac_coef: 2.58, constant: -84.22, formula: "(KH x 1.50) + (MAC x 2.58) - 84.22", see_kg: 14.52 },
  { sex: "female", race: "white", age_band: "60-80", age_min: 60, age_max: 80, kh_coef: 1.09, mac_coef: 2.68, constant: -65.51, formula: "(KH x 1.09) + (MAC x 2.68) - 65.51", see_kg: 11.42 },
  { sex: "male", race: "black", age_band: "6-18", age_min: 6, age_max: 18, kh_coef: 0.59, mac_coef: 2.73, constant: -48.32, formula: "(KH x 0.59) + (MAC x 2.73) - 48.32", see_kg: 7.5 },
  { sex: "male", race: "white", age_band: "6-18", age_min: 6, age_max: 18, kh_coef: 0.68, mac_coef: 2.64, constant: -50.08, formula: "(KH x 0.68) + (MAC x 2.64) - 50.08", see_kg: 7.82 },
  { sex: "male", race: "black", age_band: "19-59", age_min: 19, age_max: 59, kh_coef: 1.09, mac_coef: 3.14, constant: -83.72, formula: "(KH x 1.09) + (MAC x 3.14) - 83.72", see_kg: 11.3 },
  { sex: "male", race: "white", age_band: "19-59", age_min: 19, age_max: 59, kh_coef: 1.19, mac_coef: 3.21, constant: -86.82, formula: "(KH x 1.19) + (MAC x 3.21) - 86.82", see_kg: 11.42 },
  { sex: "male", race: "black", age_band: "60-80", age_min: 60, age_max: 80, kh_coef: 0.44, mac_coef: 2.86, constant: -39.21, formula: "(KH x 0.44) + (MAC x 2.86) - 39.21", see_kg: 7.04 },
  { sex: "male", race: "white", age_band: "60-80", age_min: 60, age_max: 80, kh_coef: 1.1, mac_coef: 3.07, constant: -75.81, formula: "(KH x 1.10) + (MAC x 3.07) - 75.81", see_kg: 11.46 },
];

function selectKneeHeightMacRow(sex: Sex, race: Race, ageYears: number): KneeHeightMacRow | undefined {
  return KNEE_HEIGHT_MAC_TABLE.find((r) => r.sex === sex && r.race === race && ageYears >= r.age_min && ageYears <= r.age_max);
}

// ── 2.2 Weight estimate for persons 65 years and older (Lee & Nieman) ───────
interface ElderlyWeightEquation {
  requires: Array<"muac" | "cc" | "ssf" | "kh">;
  compute: (v: { muac?: number; cc?: number; ssf?: number; kh?: number }) => number;
  formula: string;
  see_kg: number;
}

const ELDERLY_WEIGHT_EQUATIONS: Record<Sex, ElderlyWeightEquation[]> = {
  female: [
    {
      requires: ["muac", "cc"],
      compute: (v) => v.muac! * 1.63 + v.cc! * 1.43 - 37.46,
      formula: "(MUAC x 1.63) + (CC x 1.43) - 37.46",
      see_kg: 4.96,
    },
    {
      requires: ["muac", "cc", "ssf"],
      compute: (v) => v.muac! * 0.92 + v.cc! * 1.5 + v.ssf! * 0.42 - 26.19,
      formula: "(MUAC x 0.92) + (CC x 1.50) + (SSF x 0.42) - 26.19",
      see_kg: 4.21,
    },
    {
      requires: ["muac", "cc", "ssf", "kh"],
      compute: (v) => v.muac! * 0.98 + v.cc! * 1.27 + v.ssf! * 0.4 + v.kh! * 0.87 - 62.35,
      formula: "(MUAC x 0.98) + (CC x 1.27) + (SSF x 0.40) + (KH x 0.87) - 62.35",
      see_kg: 3.8,
    },
  ],
  male: [
    {
      requires: ["muac", "cc"],
      compute: (v) => v.muac! * 2.31 + v.cc! * 1.5 - 50.1,
      formula: "(MAC x 2.31) + (CC x 1.50) - 50.10",
      see_kg: 5.37,
    },
    {
      requires: ["muac", "cc", "ssf"],
      compute: (v) => v.muac! * 1.92 + v.cc! * 1.44 + v.ssf! * 0.26 - 39.97,
      formula: "(MAC x 1.92) + (CC x 1.44) + (SSF x 0.26) - 39.97",
      see_kg: 5.34,
    },
    {
      requires: ["muac", "cc", "ssf", "kh"],
      compute: (v) => v.muac! * 1.73 + v.cc! * 0.98 + v.ssf! * 0.37 + v.kh! * 1.16 - 81.69,
      formula: "(MAC x 1.73) + (CC x 0.98) + (SSF x 0.37) + (KH x 1.16) - 81.69",
      see_kg: 4.48,
    },
  ],
};

export function registerWeightEstimationTools(server: McpServer) {
  // ── weight_from_knee_height_and_mac ───────────────────────────────────────
  server.registerTool(
    "weight_from_knee_height_and_mac",
    {
      title: "Weight from Knee Height & Mid-Arm Circumference (Lee & Nieman)",
      description:
        "Estimate body weight from knee height and mid-arm circumference (MAC) when direct weighing isn't " +
        "possible, using the Lee & Nieman race/sex/age-specific equations. Covers ages 6-80 years, black or " +
        "white race, male or female. Each equation has its own standard error of the estimate, returned as " +
        "see_kg. For persons 65 years and older, weight_estimate_persons_65_and_older uses a different, " +
        "more precise equation set (adding calf circumference and skinfold).",
      inputSchema: {
        sex: z.enum(["male", "female"]),
        race: z.enum(["black", "white"]),
        age_years: z.number().positive(),
        knee_height_cm: z.number().positive(),
        mid_arm_circumference_cm: z.number().positive(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool(
      "weight_from_knee_height_and_mac",
      async ({ sex, race, age_years, knee_height_cm, mid_arm_circumference_cm }) => {
        const row = selectKneeHeightMacRow(sex, race, age_years);
        if (!row) {
          return err(
            `No matching equation for sex="${sex}", race="${race}", age_years=${age_years}. Covered age bands: 6-18, 19-59, 60-80 years.`
          );
        }
        const weightKg = row.kh_coef * knee_height_cm + row.mac_coef * mid_arm_circumference_cm + row.constant;
        return ok(
          {
            sex,
            race,
            age_years,
            age_band: row.age_band,
            knee_height_cm,
            mid_arm_circumference_cm,
            estimated_weight_kg: Math.round(weightKg * 100) / 100,
            formula: row.formula,
            see_kg: row.see_kg,
            note: "KH: knee height in cm; MAC: mid-arm circumference in cm; SEE: standard error of the estimate.",
          },
          { disclaimer: WEIGHT_ESTIMATE_DISCLAIMER, citation: "Lee & Nieman" }
        );
      }
    )
  );

  // ── weight_estimate_persons_65_and_older ──────────────────────────────────
  server.registerTool(
    "weight_estimate_persons_65_and_older",
    {
      title: "Weight Estimate for Persons 65 Years and Older (Lee & Nieman)",
      description:
        "Estimate body weight for a patient aged 65+ from whichever of mid-(upper-)arm circumference " +
        "(MUAC/MAC), calf circumference (CC), subscapular skinfold (SSF, mm), and knee height (KH) are " +
        "available, using the Lee & Nieman equation set. MUAC+CC alone gives a usable but less precise " +
        "estimate; adding SSF, then KH, progressively lowers the standard error of the estimate (SEE). " +
        "Returns every equation for which all required inputs were supplied, sorted with the most precise " +
        "(lowest SEE) result first.",
      inputSchema: {
        sex: z.enum(["male", "female"]),
        mid_arm_circumference_cm: z.number().positive().describe("MUAC (females) / MAC (males)"),
        calf_circumference_cm: z.number().positive(),
        subscapular_skinfold_mm: z.number().positive().optional(),
        knee_height_cm: z.number().positive().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool(
      "weight_estimate_persons_65_and_older",
      async ({ sex, mid_arm_circumference_cm, calf_circumference_cm, subscapular_skinfold_mm, knee_height_cm }) => {
        const values = {
          muac: mid_arm_circumference_cm,
          cc: calf_circumference_cm,
          ssf: subscapular_skinfold_mm,
          kh: knee_height_cm,
        };
        const applicable = ELDERLY_WEIGHT_EQUATIONS[sex]
          .filter((eq) => eq.requires.every((k) => values[k as keyof typeof values] !== undefined))
          .map((eq) => ({
            estimated_weight_kg: Math.round(eq.compute(values) * 100) / 100,
            formula: eq.formula,
            see_kg: eq.see_kg,
            inputs_used: eq.requires,
          }))
          .sort((a, b) => a.see_kg - b.see_kg);

        if (applicable.length === 0) {
          return err("At minimum, mid_arm_circumference_cm and calf_circumference_cm are required.");
        }

        return ok(
          {
            sex,
            estimates: applicable,
            most_precise_estimate_kg: applicable[0].estimated_weight_kg,
            note:
              "MUAC/MAC: mid-(upper-)arm circumference in cm; CC: calf circumference in cm; SSF: " +
              "subscapular skinfold in mm; KH: knee height in cm; SEE: standard error of the estimate. " +
              "Supply subscapular_skinfold_mm and/or knee_height_cm for a lower-SEE (more precise) estimate.",
          },
          { disclaimer: WEIGHT_ESTIMATE_DISCLAIMER, citation: "Lee & Nieman" }
        );
      }
    )
  );
}
