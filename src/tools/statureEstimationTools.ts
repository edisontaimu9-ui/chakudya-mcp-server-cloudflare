import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, safeTool } from "../utils/toolResult.js";

/**
 * Part B: Assessment of the Anthropometric Status of the Hospitalized
 * Patient — Section 1: Estimate Height (Stature), from knee height
 * (Lee & Nieman/Chumlea-style equations) and demi span (Gibson), as
 * compiled in a hospital dietetics anthropometry guideline.
 *
 * Pure calculation — no Chakudya API calls. Used when a patient cannot be
 * measured directly (e.g. bedridden, contractures, amputation).
 *
 * Three tools:
 *   - stature_from_knee_height   (Lee & Nieman)
 *   - stature_from_demi_span     (Gibson)
 *   - stature_from_ulna_length   (lookup table, source unlabeled in guideline)
 */

const STATURE_DISCLAIMER =
  "Estimate only, from published predictive equations for estimating stature when direct height " +
  "measurement is not possible. Each equation carries its own error margin (see error_cm) — treat the " +
  "result as an estimate band, not an exact height. Not a substitute for direct measurement when it is " +
  "obtainable.";

function err(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

// ── 1.1 Knee height (Lee & Nieman) ──────────────────────────────────────────
type Race = "black" | "white";
type Sex = "male" | "female";

interface KneeHeightRow {
  race: Race;
  sex: Sex;
  age_band: string;
  age_min: number;
  age_max: number | null; // null = no upper bound
  compute: (kneeHeightCm: number, ageYears: number) => number;
  formula: string;
  error_cm: number;
}

const KNEE_HEIGHT_TABLE: KneeHeightRow[] = [
  {
    race: "black", sex: "female", age_band: "> 60", age_min: 60, age_max: null,
    compute: (kh) => 58.72 + 1.96 * kh,
    formula: "S = 58.72 + (1.96 x KH)", error_cm: 8.26,
  },
  {
    race: "black", sex: "female", age_band: "19-60", age_min: 19, age_max: 60,
    compute: (kh, a) => 68.1 + 1.86 * kh - 0.06 * a,
    formula: "S = 68.10 + (1.86 x KH) - (0.06 x A)", error_cm: 7.6,
  },
  {
    race: "black", sex: "female", age_band: "6-18", age_min: 6, age_max: 18,
    compute: (kh) => 46.59 + 2.02 * kh,
    formula: "S = 46.59 + (2.02 x KH)", error_cm: 8.78,
  },
  {
    race: "white", sex: "female", age_band: "> 60", age_min: 60, age_max: null,
    compute: (kh, a) => 75.0 + 1.91 * kh - 0.17 * a,
    formula: "S = 75.00 + (1.91 x KH) - (0.17 x A)", error_cm: 8.82,
  },
  {
    race: "white", sex: "female", age_band: "19-60", age_min: 19, age_max: 60,
    compute: (kh, a) => 70.25 + 1.87 * kh - 0.06 * a,
    formula: "S = 70.25 + (1.87 x KH) - (0.06 x A)", error_cm: 7.2,
  },
  {
    race: "white", sex: "female", age_band: "6-18", age_min: 6, age_max: 18,
    compute: (kh) => 43.21 + 2.14 * kh,
    formula: "S = 43.21 + (2.14 x KH)", error_cm: 7.8,
  },
  {
    race: "black", sex: "male", age_band: "> 60", age_min: 60, age_max: null,
    compute: (kh) => 95.79 + 1.37 * kh,
    formula: "S = 95.79 + (1.37 x KH)", error_cm: 8.44,
  },
  {
    race: "black", sex: "male", age_band: "19-60", age_min: 19, age_max: 60,
    compute: (kh) => 73.42 + 1.79 * kh,
    formula: "S = 73.42 + (1.79 x KH)", error_cm: 7.2,
  },
  {
    race: "black", sex: "male", age_band: "6-18", age_min: 6, age_max: 18,
    compute: (kh) => 39.6 + 2.18 * kh,
    formula: "S = 39.6 + (2.18 x KH)", error_cm: 9.16,
  },
  {
    race: "white", sex: "male", age_band: "> 60", age_min: 60, age_max: null,
    compute: (kh) => 59.01 + 2.08 * kh,
    formula: "S = 59.01 + (2.08 x KH)", error_cm: 7.84,
  },
  {
    race: "white", sex: "male", age_band: "19-60", age_min: 19, age_max: 60,
    compute: (kh) => 71.85 + 1.88 * kh,
    formula: "S = 71.85 + (1.88 x KH)", error_cm: 7.94,
  },
  {
    race: "white", sex: "male", age_band: "6-18", age_min: 6, age_max: 18,
    compute: (kh) => 40.54 + 2.22 * kh,
    formula: "S = 40.54 + (2.22 x KH)", error_cm: 8.42,
  },
];

function selectKneeHeightRow(race: Race, sex: Sex, ageYears: number): KneeHeightRow | undefined {
  const candidates = KNEE_HEIGHT_TABLE.filter((r) => r.race === race && r.sex === sex);
  return candidates.find((r) => (r.age_max === null ? ageYears > r.age_min : ageYears >= r.age_min && ageYears <= r.age_max));
}

// ── 1.2 Demi span (Gibson) ───────────────────────────────────────────────────
interface DemiSpanRow {
  sex: Sex;
  age_band: string;
  age_min: number;
  age_max: number | null;
  compute: (demiSpanCm: number) => number;
  formula: string;
}

const DEMI_SPAN_TABLE: DemiSpanRow[] = [
  { sex: "male", age_band: "16-54 years", age_min: 16, age_max: 54, compute: (ds) => ds * 1.3 + 68, formula: "Height (cm) = (DS x 1.3) + 68" },
  { sex: "male", age_band: "> 55 years", age_min: 55, age_max: null, compute: (ds) => ds * 1.2 + 71, formula: "Height (cm) = (DS x 1.2) + 71" },
  { sex: "female", age_band: "16-54 years", age_min: 16, age_max: 54, compute: (ds) => ds * 1.3 + 62, formula: "Height (cm) = (DS x 1.3) + 62" },
  { sex: "female", age_band: "> 55 years", age_min: 55, age_max: null, compute: (ds) => ds * 1.2 + 67, formula: "Height (cm) = (DS x 1.2) + 67" },
];

function selectDemiSpanRow(sex: Sex, ageYears: number): DemiSpanRow | undefined {
  const candidates = DEMI_SPAN_TABLE.filter((r) => r.sex === sex);
  return candidates.find((r) => (r.age_max === null ? ageYears >= r.age_min : ageYears >= r.age_min && ageYears <= r.age_max));
}

// ── 1.3 Ulna (forearm) length lookup table ──────────────────────────────────
// Predicted height (m) from ulna length (cm), in 0.5cm increments, by sex
// and age band (<65 / >65 years).
interface UlnaRow {
  ulna_cm: number;
  men_lt65_m: number;
  men_gt65_m: number;
  women_lt65_m: number;
  women_gt65_m: number;
}

const ULNA_HEIGHT_TABLE: UlnaRow[] = [
  { ulna_cm: 32.0, men_lt65_m: 1.94, men_gt65_m: 1.87, women_lt65_m: 1.84, women_gt65_m: 1.84 },
  { ulna_cm: 31.5, men_lt65_m: 1.93, men_gt65_m: 1.86, women_lt65_m: 1.83, women_gt65_m: 1.83 },
  { ulna_cm: 31.0, men_lt65_m: 1.91, men_gt65_m: 1.84, women_lt65_m: 1.81, women_gt65_m: 1.81 },
  { ulna_cm: 30.5, men_lt65_m: 1.89, men_gt65_m: 1.82, women_lt65_m: 1.80, women_gt65_m: 1.79 },
  // men_gt65_m at 30.0cm (1.71) breaks the otherwise-monotonic sequence between
  // 30.5cm (1.82) and 29.5cm (1.79) — reproduced as printed in the source table,
  // but likely a print/scan error; verify against source if precision matters here.
  { ulna_cm: 30.0, men_lt65_m: 1.87, men_gt65_m: 1.71, women_lt65_m: 1.79, women_gt65_m: 1.78 },
  { ulna_cm: 29.5, men_lt65_m: 1.85, men_gt65_m: 1.79, women_lt65_m: 1.77, women_gt65_m: 1.76 },
  { ulna_cm: 29.0, men_lt65_m: 1.84, men_gt65_m: 1.78, women_lt65_m: 1.76, women_gt65_m: 1.75 },
  { ulna_cm: 28.5, men_lt65_m: 1.82, men_gt65_m: 1.76, women_lt65_m: 1.75, women_gt65_m: 1.73 },
  { ulna_cm: 28.0, men_lt65_m: 1.80, men_gt65_m: 1.75, women_lt65_m: 1.73, women_gt65_m: 1.71 },
  { ulna_cm: 27.5, men_lt65_m: 1.78, men_gt65_m: 1.73, women_lt65_m: 1.72, women_gt65_m: 1.70 },
  { ulna_cm: 27.0, men_lt65_m: 1.76, men_gt65_m: 1.71, women_lt65_m: 1.70, women_gt65_m: 1.68 },
  { ulna_cm: 26.5, men_lt65_m: 1.75, men_gt65_m: 1.70, women_lt65_m: 1.69, women_gt65_m: 1.66 },
  { ulna_cm: 26.0, men_lt65_m: 1.73, men_gt65_m: 1.68, women_lt65_m: 1.68, women_gt65_m: 1.65 },
  { ulna_cm: 25.5, men_lt65_m: 1.71, men_gt65_m: 1.67, women_lt65_m: 1.66, women_gt65_m: 1.63 },
  { ulna_cm: 25.0, men_lt65_m: 1.69, men_gt65_m: 1.65, women_lt65_m: 1.65, women_gt65_m: 1.61 },
  { ulna_cm: 24.5, men_lt65_m: 1.67, men_gt65_m: 1.63, women_lt65_m: 1.63, women_gt65_m: 1.60 },
  { ulna_cm: 24.0, men_lt65_m: 1.66, men_gt65_m: 1.62, women_lt65_m: 1.62, women_gt65_m: 1.58 },
  { ulna_cm: 23.5, men_lt65_m: 1.64, men_gt65_m: 1.60, women_lt65_m: 1.61, women_gt65_m: 1.56 },
  { ulna_cm: 23.0, men_lt65_m: 1.62, men_gt65_m: 1.59, women_lt65_m: 1.59, women_gt65_m: 1.55 },
  { ulna_cm: 22.5, men_lt65_m: 1.60, men_gt65_m: 1.57, women_lt65_m: 1.58, women_gt65_m: 1.53 },
  { ulna_cm: 22.0, men_lt65_m: 1.58, men_gt65_m: 1.56, women_lt65_m: 1.56, women_gt65_m: 1.52 },
  { ulna_cm: 21.5, men_lt65_m: 1.57, men_gt65_m: 1.54, women_lt65_m: 1.55, women_gt65_m: 1.50 },
  { ulna_cm: 21.0, men_lt65_m: 1.56, men_gt65_m: 1.52, women_lt65_m: 1.54, women_gt65_m: 1.48 },
  { ulna_cm: 20.5, men_lt65_m: 1.53, men_gt65_m: 1.51, women_lt65_m: 1.52, women_gt65_m: 1.47 },
  { ulna_cm: 20.0, men_lt65_m: 1.51, men_gt65_m: 1.49, women_lt65_m: 1.51, women_gt65_m: 1.45 },
  { ulna_cm: 19.5, men_lt65_m: 1.49, men_gt65_m: 1.48, women_lt65_m: 1.50, women_gt65_m: 1.44 },
  { ulna_cm: 19.0, men_lt65_m: 1.48, men_gt65_m: 1.46, women_lt65_m: 1.48, women_gt65_m: 1.42 },
  { ulna_cm: 18.5, men_lt65_m: 1.46, men_gt65_m: 1.45, women_lt65_m: 1.47, women_gt65_m: 1.40 },
];

export function registerStatureEstimationTools(server: McpServer) {
  // ── stature_from_knee_height ───────────────────────────────────────────────
  server.registerTool(
    "stature_from_knee_height",
    {
      title: "Stature from Knee Height (Lee & Nieman)",
      description:
        "Estimate stature (height) from knee height when direct measurement isn't possible, using the " +
        "Lee & Nieman race/sex/age-specific equations. Requires race (black/white), sex, age in years, and " +
        "knee height in cm. Each equation has its own error margin, returned as error_cm.",
      inputSchema: {
        race: z.enum(["black", "white"]),
        sex: z.enum(["male", "female"]),
        age_years: z.number().positive(),
        knee_height_cm: z.number().positive(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("stature_from_knee_height", async ({ race, sex, age_years, knee_height_cm }) => {
      const row = selectKneeHeightRow(race, sex, age_years);
      if (!row) {
        return err(
          `No matching equation for race="${race}", sex="${sex}", age_years=${age_years}. ` +
            `Covered age bands: 6-18, 19-60, and >60 years.`
        );
      }
      const statureCm = row.compute(knee_height_cm, age_years);
      return ok(
        {
          race,
          sex,
          age_years,
          age_band: row.age_band,
          knee_height_cm,
          estimated_stature_cm: Math.round(statureCm * 100) / 100,
          formula: row.formula,
          error_cm: row.error_cm,
          note: "S: stature in cm; KH: knee height in cm; A: age in years.",
        },
        { disclaimer: STATURE_DISCLAIMER, citation: "Lee & Nieman" }
      );
    })
  );

  // ── stature_from_demi_span ─────────────────────────────────────────────────
  server.registerTool(
    "stature_from_demi_span",
    {
      title: "Stature from Demi Span (Gibson)",
      description:
        "Estimate stature (height) from demi span (sternal notch to finger web between middle/ring finger, " +
        "with arm outstretched horizontally) when direct measurement isn't possible, using the Gibson sex/" +
        "age-specific equations. Requires sex, age in years, and demi span in cm.",
      inputSchema: {
        sex: z.enum(["male", "female"]),
        age_years: z.number().positive(),
        demi_span_cm: z.number().positive(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("stature_from_demi_span", async ({ sex, age_years, demi_span_cm }) => {
      const row = selectDemiSpanRow(sex, age_years);
      if (!row) {
        return err(`No matching equation for sex="${sex}", age_years=${age_years}. Minimum covered age is 16 years.`);
      }
      const heightCm = row.compute(demi_span_cm);
      return ok(
        {
          sex,
          age_years,
          age_band: row.age_band,
          demi_span_cm,
          estimated_height_cm: Math.round(heightCm * 100) / 100,
          formula: row.formula,
          note: "DS: demi span in cm.",
        },
        { disclaimer: STATURE_DISCLAIMER, citation: "Gibson" }
      );
    })
  );

  // ── stature_from_ulna_length ───────────────────────────────────────────────
  server.registerTool(
    "stature_from_ulna_length",
    {
      title: "Stature from Ulna (Forearm) Length",
      description:
        "Look up predicted height (m) from ulna (forearm) length, sex, and age band (<65 or >=65 years), " +
        "using a reference table in 0.5cm ulna-length increments (range 18.5-32.0cm). The input value is " +
        "rounded to the nearest 0.5cm table entry.",
      inputSchema: {
        sex: z.enum(["male", "female"]),
        age_years: z.number().positive(),
        ulna_length_cm: z.number().min(18.5).max(32.0),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("stature_from_ulna_length", async ({ sex, age_years, ulna_length_cm }) => {
      const roundedUlna = Math.round(ulna_length_cm * 2) / 2;
      const row = ULNA_HEIGHT_TABLE.find((r) => r.ulna_cm === roundedUlna);
      if (!row) {
        return err(`ulna_length_cm ${ulna_length_cm} is outside the table range (18.5-32.0cm).`);
      }
      const ageBand = age_years >= 65 ? "gt65" : "lt65";
      const heightM =
        sex === "male" ? (ageBand === "lt65" ? row.men_lt65_m : row.men_gt65_m) : ageBand === "lt65" ? row.women_lt65_m : row.women_gt65_m;

      return ok(
        {
          sex,
          age_years,
          age_band: ageBand === "lt65" ? "<65 years" : ">=65 years",
          ulna_length_cm,
          matched_table_ulna_cm: roundedUlna,
          estimated_height_m: heightM,
          estimated_height_cm: Math.round(heightM * 100),
          note:
            roundedUlna === 30.0 && sex === "male" && ageBand === "gt65"
              ? "This table cell (men >65 years, 30.0cm ulna = 1.71m) breaks the otherwise-monotonic sequence in the source table and may be a print/scan error — verify against source."
              : undefined,
        },
        { disclaimer: STATURE_DISCLAIMER }
      );
    })
  );
}
