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
 * Two tools:
 *   - stature_from_knee_height   (Lee & Nieman)
 *   - stature_from_demi_span     (Gibson)
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
}
