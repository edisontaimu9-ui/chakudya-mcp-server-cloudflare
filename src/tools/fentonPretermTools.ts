import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, toolError, safeTool } from "../utils/toolResult.js";
import { chakudyaClient } from "../clients/chakudyaClient.js";

/**
 * Fenton preterm growth chart (2013 and 2025 references) via the Chakudya
 * API's /fenton-preterm/* endpoints.
 *
 * LICENSE — read before touching this file. The underlying LMS parameters
 * are shared by Dr. Tanis Fenton (University of Calgary) under CC BY-NC-ND
 * 4.0, non-commercial use in this application only, with two hard
 * conditions: the raw data must never be visible to end users, and never
 * shared with other organizations. chakudya-api enforces this server-side —
 * every /fenton-preterm/* route it exposes returns a computed result
 * (a z-score/percentile/status, a rendered image, or static metadata),
 * NEVER the raw L/M/S table. There is no list/dump route on that API for
 * this resource, and there must never be one here either:
 *   - Do not add a tool that requests or surfaces L, M, or S values.
 *   - fenton_preterm_chart below returns the rendered SVG as text (the
 *     model can display/pass it along), never a parsed numeric curve.
 * If this condition ever needs to change, that's a conversation with Edison
 * about the data-sharing agreement, not a routine tool addition.
 *
 * Unlike INTERGROWTH-21st (intergrowthPretermGrowthTools.ts), which is
 * public-domain data transcribed directly into this repo, Fenton's data
 * only ever exists inside chakudya-api's database — every tool here is a
 * thin wrapper over an HTTP call, no local computation or data.
 *
 * Screening aid only, not a diagnosis.
 */

const SexEnum = z.enum(["male", "female"]);
const MetricEnum = z.enum(["weight", "length", "hc"]);
const ReferenceYearEnum = z.union([z.literal(2013), z.literal(2025)]);

function apiSex(sex: "male" | "female"): "boys" | "girls" {
  return sex === "male" ? "boys" : "girls";
}

const MeasurementSchema = z.object({
  gest_age_weeks: z.number().min(22).max(50),
  day: z.number().int().min(0).max(6).optional().describe("Day of the gestational week (0-6). Default 0."),
  value: z.number().positive().describe("Grams for weight, cm for length/hc."),
});

const DISCLAIMER =
  "Screening aid only, not a diagnosis. From the Chakudya API's licensed Fenton preterm growth chart " +
  "endpoints (Dr. Tanis Fenton, University of Calgary) — 2013 (Fenton & Kim, BMC Pediatrics 2013;13:59) " +
  "or 2025 (Fenton, Elmrayed & Alshaikh, Paediatric and Perinatal Epidemiology 2025) reference. SGA/LGA " +
  "labels are only valid AT BIRTH per Fenton's own guidance — 'status' here is a generic +/-2SD read " +
  "usable at any age for interval growth monitoring, not a birth-specific SGA/LGA call.";

export function registerFentonPretermTools(server: McpServer): void {
  server.registerTool(
    "fenton_preterm_classify",
    {
      title: "Fenton Preterm Growth Chart — Classify One Measurement",
      description:
        "Classify a single preterm infant measurement (weight, length, or head circumference) against the " +
        "Fenton preterm growth chart (2013 or 2025 reference, default 2025) via the Chakudya API's " +
        "/fenton-preterm/classify endpoint. Returns z-score, percentile, and a generic +/-2SD status " +
        "(small/appropriate/large). For all three metrics at one timepoint use fenton_preterm_profile; for " +
        "a series over time use fenton_preterm_growth. Screening aid only, not a diagnosis.",
      inputSchema: {
        sex: SexEnum,
        metric: MetricEnum,
        gest_age_weeks: z.number().min(22).max(50).describe("Gestational/postmenstrual age in completed weeks."),
        day: z.number().int().min(0).max(6).optional().describe("Day of the gestational week (0-6). Default 0."),
        value: z.number().positive().describe("Grams for weight, cm for length/hc."),
        reference_year: ReferenceYearEnum.optional().describe("2013 or 2025 (default 2025)."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safeTool("fenton_preterm_classify", async ({ sex, metric, gest_age_weeks, day, value, reference_year }) => {
      const res = await chakudyaClient.get("/fenton-preterm/classify", {
        sex: apiSex(sex),
        metric,
        gest_age_weeks,
        day,
        value,
        reference_year,
      });
      return ok(res.data, { disclaimer: DISCLAIMER });
    })
  );

  server.registerTool(
    "fenton_preterm_profile",
    {
      title: "Fenton Preterm Growth Chart — Weight + Length + HC Profile",
      description:
        "Classify weight, length, and head circumference together at one timepoint, via the Chakudya API's " +
        "/fenton-preterm/profile endpoint. Provide at least one of weight_g/length_cm/hc_cm — any combination " +
        "is fine. Returns z-score/percentile/status per metric provided. Screening aid only, not a diagnosis.",
      inputSchema: {
        sex: SexEnum,
        gest_age_weeks: z.number().min(22).max(50),
        day: z.number().int().min(0).max(6).optional().describe("Day of the gestational week (0-6). Default 0."),
        weight_g: z.number().positive().optional().describe("Weight in grams."),
        length_cm: z.number().positive().optional().describe("Length in cm."),
        hc_cm: z.number().positive().optional().describe("Head circumference in cm."),
        reference_year: ReferenceYearEnum.optional().describe("2013 or 2025 (default 2025)."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safeTool(
      "fenton_preterm_profile",
      async ({ sex, gest_age_weeks, day, weight_g, length_cm, hc_cm, reference_year }) => {
        if (weight_g === undefined && length_cm === undefined && hc_cm === undefined) {
          throw new Error("Provide at least one of weight_g, length_cm, hc_cm.");
        }
        const res = await chakudyaClient.post("/fenton-preterm/profile", {
          sex: apiSex(sex),
          gest_age_weeks,
          day,
          weight: weight_g,
          length: length_cm,
          hc: hc_cm,
          reference_year,
        });
        return ok(res.data, { disclaimer: DISCLAIMER });
      }
    )
  );

  server.registerTool(
    "fenton_preterm_growth",
    {
      title: "Fenton Preterm Growth Chart — Trajectory Over Time",
      description:
        "Classify a series of same-metric measurements over time (up to 50 points) via the Chakudya API's " +
        "/fenton-preterm/growth endpoint. Returns each point's z-score/percentile/status plus a descriptive " +
        "trend summary (first/last/min/max z, and any consecutive-point drop of >=0.67 SD flagged as a " +
        "notable percentile-band crossing — descriptive only, not a clinical threshold). For velocity " +
        "(g/kg/day or cm/week) use fenton_preterm_velocity instead. Screening aid only, not a diagnosis.",
      inputSchema: {
        sex: SexEnum,
        metric: MetricEnum,
        measurements: z.array(MeasurementSchema).min(1).max(50),
        reference_year: ReferenceYearEnum.optional().describe("2013 or 2025 (default 2025)."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safeTool("fenton_preterm_growth", async ({ sex, metric, measurements, reference_year }) => {
      const res = await chakudyaClient.post("/fenton-preterm/growth", {
        sex: apiSex(sex),
        metric,
        measurements,
        reference_year,
      });
      return ok(res.data, { disclaimer: DISCLAIMER });
    })
  );

  server.registerTool(
    "fenton_preterm_velocity",
    {
      title: "Fenton Preterm Growth Chart — Growth Velocity",
      description:
        "Compute growth velocity between consecutive same-metric measurements (2+ points) via the Chakudya " +
        "API's /fenton-preterm/velocity endpoint. Weight is g/kg/day (average-weight method: delta-weight / " +
        "average-weight-kg / days — the long-standing NICU convention); length/hc are cm/week. Returns one " +
        "interval per consecutive pair. Screening aid only, not a diagnosis.",
      inputSchema: {
        sex: SexEnum,
        metric: MetricEnum,
        measurements: z.array(MeasurementSchema).min(2).max(50),
        reference_year: ReferenceYearEnum.optional().describe("2013 or 2025 (default 2025)."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safeTool("fenton_preterm_velocity", async ({ sex, metric, measurements, reference_year }) => {
      const res = await chakudyaClient.post("/fenton-preterm/velocity", {
        sex: apiSex(sex),
        metric,
        measurements,
        reference_year,
      });
      return ok(res.data, { disclaimer: DISCLAIMER });
    })
  );

  server.registerTool(
    "fenton_preterm_chart",
    {
      title: "Fenton Preterm Growth Chart — Rendered SVG Image",
      description:
        "Render a Fenton preterm growth chart (P3/P10/P50/P90/P97 reference curves) as an SVG image, via the " +
        "Chakudya API's /fenton-preterm/chart endpoint, optionally overlaying an infant's own measurements as " +
        "a dotted trajectory. Returns raw SVG markup as text (never numeric curve data — this endpoint stays " +
        "an image by design, per Dr. Fenton's license terms). Pass points as an array of " +
        "{gest_age_weeks, day?, value} to overlay a trajectory.",
      inputSchema: {
        sex: SexEnum,
        metric: MetricEnum,
        reference_year: ReferenceYearEnum.optional().describe("2013 or 2025 (default 2025)."),
        points: z
          .array(MeasurementSchema)
          .max(50)
          .optional()
          .describe("Optional overlay points (the infant's own measurements) to plot on the chart."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safeTool("fenton_preterm_chart", async ({ sex, metric, reference_year, points }) => {
      const pointsParam = points?.length
        ? points.map((p) => `${p.gest_age_weeks}w${p.day ?? 0}d:${p.value}`).join(",")
        : undefined;
      const { text, contentType } = await chakudyaClient.getRaw("/fenton-preterm/chart", {
        sex: apiSex(sex),
        metric,
        reference_year,
        points: pointsParam,
      });
      if (!contentType.includes("svg")) {
        return toolError(`Expected an SVG image from /fenton-preterm/chart but got content-type "${contentType}".`);
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `${DISCLAIMER}\n\nSVG chart (${sex} ${metric}, ${reference_year ?? 2025} reference):\n\n${text}`,
          },
        ],
      };
    })
  );

  server.registerTool(
    "fenton_preterm_references",
    {
      title: "Fenton Preterm Growth Chart — Reference Metadata",
      description:
        "Static metadata for the Fenton preterm growth chart via the Chakudya API's /fenton-preterm/references " +
        "endpoint: both years' citations/DOIs, sexes, metrics, the exact valid age range per (year, metric), " +
        "and the license summary. No L/M/S values or anything the curve could be reconstructed from. Useful " +
        "for checking valid input ranges before calling the other fenton_preterm_* tools.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safeTool("fenton_preterm_references", async () => {
      const res = await chakudyaClient.get("/fenton-preterm/references");
      return ok(res.data);
    })
  );
}
