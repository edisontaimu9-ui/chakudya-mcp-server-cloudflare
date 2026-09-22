import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, safeTool } from "../utils/toolResult.js";
import wfaBoys from "../data/intergrowth/wfa-boys-zscores.json" with { type: "json" };
import wfaGirls from "../data/intergrowth/wfa-girls-zscores.json" with { type: "json" };
import lfaBoys from "../data/intergrowth/lfa-boys-zscores.json" with { type: "json" };
import lfaGirls from "../data/intergrowth/lfa-girls-zscores.json" with { type: "json" };
import hcfaBoys from "../data/intergrowth/hcfa-boys-zscores.json" with { type: "json" };
import hcfaGirls from "../data/intergrowth/hcfa-girls-zscores.json" with { type: "json" };

/**
 * INTERGROWTH-21st International Postnatal Growth Standards for Preterm Infants
 * (Villar J et al. Lancet Glob Health 2015;3:e681-91) — the standard used to track a preterm
 * infant's weight/length/head-circumference growth by postmenstrual age after birth, covering
 * roughly the same purpose as the Fenton 2013 chart.
 *
 * Unlike Fenton's chart, INTERGROWTH-21st publishes its underlying z-score tables freely
 * (© University of Oxford, released by the INTERGROWTH-21st Network via The Global Health
 * Network): https://intergrowth21.tghn.org/articles/intergrowth-21st-postnatal-growth-standards-and-z-scores-preterm-infants/
 * Each table below is transcribed verbatim from those official PDFs — 38 rows (27 to 64 exact
 * postmenstrual weeks), 7 z-score columns (-3 to 3) each. No values are estimated or interpolated
 * from a chart image.
 *
 * If Edison later obtains the equivalent Fenton 2013 LMS data directly from Dr. Fenton, add a
 * parallel fentonGrowthTools.ts module rather than trying to make this one cover both — the two
 * standards use different source data and should stay distinguishable in tool output.
 *
 * Pure calculation — no Chakudya API calls.
 */

export const DISCLAIMER =
  "Estimate only, computed from the official INTERGROWTH-21st Postnatal Growth Standards for " +
  "Preterm Infants z-score tables (Villar et al, Lancet Glob Health 2015;3:e681-91). Covers 27 " +
  "to 64 exact postmenstrual weeks only. A single measurement is not a substitute for tracking " +
  "growth trajectory over time and clinical assessment.";

export const MIN_WEEK = 27;
export const MAX_WEEK = 64;
const Z_VALUES = [-3, -2, -1, 0, 1, 2, 3];

// [postmenstrual_week, value_at_z-3, ..., value_at_z+3]
type ZRow = [number, number, number, number, number, number, number, number];

type Measurement = "weight" | "length" | "head_circumference";

const TABLES: Record<Measurement, { male: ZRow[]; female: ZRow[]; unit: string }> = {
  weight: { male: wfaBoys as unknown as ZRow[], female: wfaGirls as unknown as ZRow[], unit: "kg" },
  length: { male: lfaBoys as unknown as ZRow[], female: lfaGirls as unknown as ZRow[], unit: "cm" },
  head_circumference: { male: hcfaBoys as unknown as ZRow[], female: hcfaGirls as unknown as ZRow[], unit: "cm" },
};

/** Linearly interpolate the 7 z-column values for an exact (possibly fractional) postmenstrual week. */
function interpolateRow(rows: ZRow[], week: number): number[] | null {
  if (week < rows[0][0] || week > rows[rows.length - 1][0]) return null;

  let lo = 0;
  let hi = rows.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (rows[mid][0] <= week) lo = mid;
    else hi = mid;
  }

  const low = rows[lo];
  const high = rows[hi];
  if (low[0] === week) return low.slice(1);

  const frac = (week - low[0]) / (high[0] - low[0]);
  const out: number[] = [];
  for (let i = 1; i <= 7; i++) out.push(low[i] + (high[i] - low[i]) * frac);
  return out;
}

/**
 * Converts a measured value to a z-score against 7 tabulated z-column values, by linear
 * interpolation between the two columns the value falls between. A value outside the -3..3
 * tabulated range is extrapolated using the slope of the nearest outer segment (-3 to -2, or
 * 2 to 3) — the standard approach for reading z-scores beyond a table's tabulated extremes.
 */
function zFromColumns(value: number, columns: number[]): number {
  if (value <= columns[0]) {
    const slope = columns[1] - columns[0];
    return -3 + (value - columns[0]) / slope;
  }
  if (value >= columns[6]) {
    const slope = columns[6] - columns[5];
    return 3 + (value - columns[6]) / slope;
  }
  for (let i = 0; i < 6; i++) {
    if (value >= columns[i] && value <= columns[i + 1]) {
      return Z_VALUES[i] + (value - columns[i]) / (columns[i + 1] - columns[i]);
    }
  }
  // Unreachable given the bounds checks above.
  return NaN;
}

// Abramowitz & Stegun normal CDF approximation (same formula as whoGrowthTools.ts).
function normalCdf(zVal: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(zVal));
  const d = 0.3989423 * Math.exp((-zVal * zVal) / 2);
  let prob = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (zVal > 0) prob = 1 - prob;
  return prob;
}

export function classify(zVal: number): string {
  if (zVal < -3) return "severely small for postmenstrual age";
  if (zVal < -2) return "small for postmenstrual age";
  if (zVal > 3) return "severely large for postmenstrual age";
  if (zVal > 2) return "large for postmenstrual age";
  return "appropriate for postmenstrual age";
}

export interface IntergrowthPngInput {
  measurement: Measurement;
  sex: "male" | "female";
  value: number;
  postmenstrual_age_weeks: number;
}

export interface IntergrowthPngResult {
  measurement: Measurement;
  unit: string;
  sex: "male" | "female";
  postmenstrual_age_weeks: number;
  value: number;
  z_score: number;
  percentile: number;
  classification: string;
  extrapolated: boolean;
}

export type IntergrowthPngOutcome = { ok: true; result: IntergrowthPngResult } | { ok: false; error: string };

export function computeIntergrowthPngZScore(input: IntergrowthPngInput): IntergrowthPngOutcome {
  const { measurement, sex, value, postmenstrual_age_weeks: week } = input;

  const entry = TABLES[measurement];
  if (!entry) {
    return { ok: false, error: `Unknown measurement "${measurement}". Use weight, length, or head_circumference.` };
  }
  if (week < MIN_WEEK || week > MAX_WEEK) {
    return {
      ok: false,
      error:
        `postmenstrual_age_weeks (${week}) is outside the standard's range: ${MIN_WEEK}-${MAX_WEEK} exact weeks. ` +
        "For a term-born or older infant use who_growth_zscore instead (chronological/corrected age).",
    };
  }

  const columns = interpolateRow(entry[sex], week);
  if (!columns) {
    return { ok: false, error: `postmenstrual_age_weeks (${week}) is outside the standard's range: ${MIN_WEEK}-${MAX_WEEK} exact weeks.` };
  }

  const zVal = zFromColumns(value, columns);
  const percentile = normalCdf(zVal) * 100;

  return {
    ok: true,
    result: {
      measurement,
      unit: entry.unit,
      sex,
      postmenstrual_age_weeks: week,
      value,
      z_score: Math.round(zVal * 100) / 100,
      percentile: Math.round(Math.min(100, Math.max(0, percentile)) * 10) / 10,
      classification: classify(zVal),
      extrapolated: value < columns[0] || value > columns[6],
    },
  };
}

export function registerIntergrowthPretermGrowthTools(server: McpServer) {
  server.registerTool(
    "intergrowth_preterm_postnatal_growth_zscore",
    {
      title: "INTERGROWTH-21st Preterm Postnatal Growth Z-Score",
      description:
        "Compute an INTERGROWTH-21st Postnatal Growth Standards for Preterm Infants z-score and " +
        "approximate percentile (Villar et al, Lancet Glob Health 2015) for weight (kg), length " +
        "(cm), or head_circumference (cm) at a given postmenstrual age in exact weeks (27-64). " +
        "This is the openly published alternative to the Fenton 2013 chart, used to track a " +
        "preterm infant's growth after birth against a postmenstrual-age reference (not " +
        "chronological/corrected age from birth — use who_growth_zscore for that once the infant " +
        "is past 64 postmenstrual weeks or you're assessing corrected age against WHO standards). " +
        "Values outside 27-64 weeks are rejected rather than guessed.",
      inputSchema: {
        measurement: z.enum(["weight", "length", "head_circumference"]),
        sex: z.enum(["male", "female"]),
        value: z.number().positive().describe("kg for weight; cm for length or head_circumference"),
        postmenstrual_age_weeks: z
          .number()
          .min(MIN_WEEK)
          .max(MAX_WEEK)
          .describe(`Exact postmenstrual age in weeks, ${MIN_WEEK}-${MAX_WEEK} (fractional weeks OK, e.g. 32.5)`),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("intergrowth_preterm_postnatal_growth_zscore", async (args) => {
      const outcome = computeIntergrowthPngZScore(args);
      if (!outcome.ok) {
        return { content: [{ type: "text" as const, text: outcome.error }], isError: true as const };
      }
      return ok({ ...outcome.result, disclaimer: DISCLAIMER });
    })
  );
}
