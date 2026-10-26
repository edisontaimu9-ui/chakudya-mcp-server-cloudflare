import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { chakudyaClient } from "../clients/chakudyaClient.js";
import { safeTool, toolError } from "../utils/toolResult.js";
import { okWithApiMeta } from "../utils/apiMeta.js";

/**
 * Paediatric clinical nutrition calculators, on chakudya-api (/paediatric/*).
 *
 * Sources (cited in each API result): BND 415 Clinical Nutrition — Paediatric Medicine Resources
 * (Holliday-Segar, Schofield 1985, WHO 1985, DRI/FAO 2004, DRI/IOM 2006, IOM 2005 protein RDA,
 * ASPEN Paediatric and Neonatal Nutrition Support Handbook 3rd ed. growth velocity / preterm /
 * enteral feed tables).
 *
 * The tables and formulas live in the API (src/paediatric.js), which is the single source of truth.
 * These tools only pass the inputs through. Educational and clinical-support estimates only, not a
 * substitute for individualized dietetic assessment.
 *
 * Tools:
 *   - pediatric_fluid_requirements         POST /paediatric/fluid
 *   - pediatric_energy_requirements        POST /paediatric/energy
 *   - pediatric_protein_requirements       POST /paediatric/protein (healthy, sick) or /paediatric/preterm
 *   - pediatric_growth_velocity            GET  /paediatric/reference?section=growth_velocity | preterm
 *   - pediatric_enteral_feed_advancement   POST /paediatric/enteral-feeds, or GET /paediatric/reference?section=enteral_feeds
 *   - preterm_fluid_energy_requirements    POST /paediatric/preterm
 *   - macronutrient_distribution_check     GET  /paediatric/reference?section=macronutrient_distribution
 */

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

/** Reads one section of the API's paediatric reference tables. */
export async function fetchPaediatricReference(section: string): Promise<unknown> {
  const res = await chakudyaClient.get("/paediatric/reference", { section });
  const data = (res as { data?: Record<string, unknown> }).data ?? {};
  return data[section];
}

interface AmdrRow {
  age: string;
  carbohydrate: [number, number];
  fat: [number, number];
  protein: [number, number];
}

/** Same age split the API uses for the AMDR rows: under 12 months, 12-47 months, 4 years and over. */
function amdrIndex(ageMonths: number): number {
  return ageMonths < 12 ? 0 : ageMonths < 48 ? 1 : 2;
}

export function registerPediatricTools(server: McpServer) {
  // ── pediatric_fluid_requirements ──────────────────────────────────────────
  server.registerTool(
    "pediatric_fluid_requirements",
    {
      title: "Pediatric Fluid Requirements (Holliday-Segar)",
      description:
        "Compute daily maintenance fluid requirement for a child using the Holliday-Segar method, given " +
        "body weight in kg. Returns total mL/day and mL/hr.",
      inputSchema: {
        weight_kg: z.number().positive(),
      },
      annotations: READ,
    },
    safeTool("pediatric_fluid_requirements", async ({ weight_kg }) => {
      const res = await chakudyaClient.post("/paediatric/fluid", { weight_kg });
      return okWithApiMeta(res);
    })
  );

  // ── pediatric_energy_requirements ─────────────────────────────────────────
  server.registerTool(
    "pediatric_energy_requirements",
    {
      title: "Pediatric Energy Requirements (BMR/TEE)",
      description:
        "Estimate pediatric energy needs. The result carries every applicable method at once: Schofield 1985 " +
        "BMR (needs height_cm), WHO 1985 BMR, the DRI/FAO 2004 kcal/kg/day TEE table, and the DRI/IOM 2006 EER " +
        "(from 3 years it uses physical_activity_level), plus a recommended figure and macronutrient grams. " +
        "Needs sex, weight_kg and age_years or age_months. Optionally supply activity_factor and/or stress_factor " +
        "(activity 1.0-2.15, stress 0.7-2.5) to scale BMR up to an estimated TEE. 'method' is accepted for " +
        "backward compatibility and no longer changes what is returned.",
      inputSchema: {
        method: z.enum(["schofield_bmr", "who_bmr", "dri_fao_2004", "dri_iom_2006"]).optional(),
        sex: z.enum(["male", "female"]),
        weight_kg: z.number().positive(),
        height_cm: z.number().positive().optional(),
        age_years: z.number().nonnegative().optional(),
        age_months: z.number().nonnegative().optional(),
        activity_factor: z.number().positive().optional().describe("Multiplier applied to BMR, e.g. 1.0-2.15"),
        stress_factor: z.number().positive().optional().describe("Multiplier applied to BMR, e.g. 0.7-2.5"),
        physical_activity_level: z
          .enum(["sedentary", "low_active", "active", "very_active"])
          .optional()
          .describe("Used for the DRI/IOM 2006 EER when age >= 3 years"),
      },
      annotations: READ,
    },
    safeTool("pediatric_energy_requirements", async (input) => {
      const { method: _method, physical_activity_level, ...rest } = input;
      const res = await chakudyaClient.post("/paediatric/energy", { ...rest, pal_category: physical_activity_level });
      return okWithApiMeta(res);
    })
  );

  // ── pediatric_protein_requirements ────────────────────────────────────────
  server.registerTool(
    "pediatric_protein_requirements",
    {
      title: "Pediatric Protein Requirements",
      description:
        "Look up pediatric protein requirement (g/kg/d) from a published source and compute total g/day for " +
        "a given weight. Sources: 'iom_2005' (healthy growth RDA, by age in months/years), 'aspen_sick' " +
        "(ASPEN dosing guideline for sick children, by age) or 'preterm' (ASPEN enteral preterm infant " +
        "protein by weight band; pass weight_kg as normal, it is converted to grams).",
      inputSchema: {
        source: z.enum(["iom_2005", "aspen_sick", "preterm"]),
        weight_kg: z.number().positive(),
        age_years: z.number().nonnegative().optional(),
        age_months: z.number().nonnegative().optional(),
      },
      annotations: READ,
    },
    safeTool("pediatric_protein_requirements", async ({ source, weight_kg, age_years, age_months }) => {
      if (source === "preterm") {
        const res = await chakudyaClient.post("/paediatric/preterm", { weight_g: weight_kg * 1000 });
        return okWithApiMeta(res);
      }
      if (age_years === undefined && age_months === undefined) return toolError("age_years or age_months is required for this source.");
      const res = await chakudyaClient.post("/paediatric/protein", {
        weight_kg,
        age_years,
        age_months,
        clinical_status: source === "aspen_sick" ? "sick" : "healthy",
      });
      return okWithApiMeta(res);
    })
  );

  // ── pediatric_growth_velocity ─────────────────────────────────────────────
  server.registerTool(
    "pediatric_growth_velocity",
    {
      title: "Pediatric Growth Velocity Reference",
      description:
        "Look up expected/reference growth velocity (weight gain, linear growth) from the ASPEN Paediatric " +
        "and Neonatal Nutrition Support Handbook, 3rd edition. Set preterm=true for the preterm infant " +
        "reference (requirements and growth monitoring targets). Otherwise returns the term table: infants " +
        "0-24 months (girls and boys separately) and children 2 to under 11 years. Pass age_months or " +
        "age_years (and sex for infants) to have the request echoed beside the table; read the row that " +
        "matches. To measure an actual child against this reference use pediatric_growth_velocity_assessment.",
      inputSchema: {
        preterm: z.boolean().optional().default(false),
        sex: z.enum(["male", "female"]).optional().describe("Needed to read the right column for term infants age_months <= 24"),
        age_months: z.number().nonnegative().optional(),
        age_years: z.number().nonnegative().optional(),
      },
      annotations: READ,
    },
    safeTool("pediatric_growth_velocity", async ({ preterm, sex, age_months, age_years }) => {
      const section = preterm ? "preterm" : "growth_velocity";
      const reference = await fetchPaediatricReference(section);
      return okWithApiMeta({
        section,
        requested: preterm ? undefined : { sex, age_months, age_years },
        reference,
      });
    })
  );

  // ── pediatric_enteral_feed_advancement ────────────────────────────────────
  server.registerTool(
    "pediatric_enteral_feed_advancement",
    {
      title: "Pediatric Enteral Feed Initiation & Advancement",
      description:
        "Initiation, advancement and goal volume guidance for pediatric enteral feeds (continuous or bolus) by " +
        "age, from the Pediatric and Nutrition Support Handbook, 3rd edition (2024). With age only it returns " +
        "the handbook table; add weight_kg to get absolute volumes for the child. For a full plan with a " +
        "formula and energy target use pediatric_enteral_feed_plan.",
      inputSchema: {
        age_years: z.number().nonnegative(),
        feed_type: z.enum(["continuous", "bolus"]).optional(),
        weight_kg: z.number().positive().optional().describe("Optional: returns volumes for this child instead of the raw table"),
      },
      annotations: READ,
    },
    safeTool("pediatric_enteral_feed_advancement", async ({ age_years, feed_type, weight_kg }) => {
      if (weight_kg !== undefined) {
        const res = await chakudyaClient.post("/paediatric/enteral-feeds", { age_years, weight_kg, route: feed_type });
        return okWithApiMeta(res);
      }
      const reference = await fetchPaediatricReference("enteral_feeds");
      return okWithApiMeta({ section: "enteral_feeds", requested: { age_years, feed_type }, reference });
    })
  );

  // ── preterm_fluid_energy_requirements ─────────────────────────────────────
  server.registerTool(
    "preterm_fluid_energy_requirements",
    {
      title: "Preterm Infant Fluid & Energy Requirements",
      description:
        "Estimated enteral fluid, energy and protein requirements for preterm infants (BND 415 Paediatric " +
        "Medicine Resources / ASPEN), as mL/kg/day and kcal/kg/day ranges plus totals for the given weight.",
      inputSchema: {
        weight_kg: z.number().positive(),
      },
      annotations: READ,
    },
    safeTool("preterm_fluid_energy_requirements", async ({ weight_kg }) => {
      const res = await chakudyaClient.post("/paediatric/preterm", { weight_g: weight_kg * 1000 });
      return okWithApiMeta(res);
    })
  );

  // ── macronutrient_distribution_check ──────────────────────────────────────
  server.registerTool(
    "macronutrient_distribution_check",
    {
      title: "Macronutrient Distribution Range Check",
      description:
        "Look up the DRI acceptable macronutrient distribution range (% of kcal from carbohydrate, fat, " +
        "protein) for a pediatric age group, and optionally check whether a proposed diet's percentages fall " +
        "inside those ranges. The ranges come from the API; only the in-range comparison is done here.",
      inputSchema: {
        age_months: z.number().nonnegative().optional(),
        age_years: z.number().nonnegative().optional(),
        proposed_carb_percent: z.number().min(0).max(100).optional(),
        proposed_fat_percent: z.number().min(0).max(100).optional(),
        proposed_protein_percent: z.number().min(0).max(100).optional(),
      },
      annotations: READ,
    },
    safeTool(
      "macronutrient_distribution_check",
      async ({ age_months, age_years, proposed_carb_percent, proposed_fat_percent, proposed_protein_percent }) => {
        const months = age_months ?? (age_years !== undefined ? age_years * 12 : undefined);
        if (months === undefined) return toolError("age_months or age_years is required.");
        const section = (await fetchPaediatricReference("macronutrient_distribution")) as { source?: string; ranges?: AmdrRow[] } | undefined;
        const row = section?.ranges?.[amdrIndex(months)];
        if (!row) return toolError("The API did not return macronutrient distribution ranges.");
        const inRange = (val: number | undefined, range: [number, number]) => (val === undefined ? null : val >= range[0] && val <= range[1]);
        const hasProposal = [proposed_carb_percent, proposed_fat_percent, proposed_protein_percent].some((v) => v !== undefined);
        return okWithApiMeta({
          source: section?.source,
          age_bracket: row.age,
          carbohydrate_percent_range: row.carbohydrate,
          fat_percent_range: row.fat,
          protein_percent_range: row.protein,
          proposed_check: hasProposal
            ? {
                carbohydrate_in_range: inRange(proposed_carb_percent, row.carbohydrate),
                fat_in_range: inRange(proposed_fat_percent, row.fat),
                protein_in_range: inRange(proposed_protein_percent, row.protein),
              }
            : null,
        });
      }
    )
  );
}
