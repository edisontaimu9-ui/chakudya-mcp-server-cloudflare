import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { chakudyaClient } from "../clients/chakudyaClient.js";
import { ok, safeTool } from "../utils/toolResult.js";

/**
 * Dietary Reference Intakes (EAR/RDA/AI/UL/AMDR by life stage — official
 * Food and Nutrition Board/NASEM tables) served live from the Chakudya API
 * (src/dri_data.js there). This is a DIFFERENT data source from the local,
 * static tables in dietaryReferenceIntakeTables.ts (a hospital dietetics
 * reference sheet) — this one covers full life-stage granularity (age/sex/
 * pregnancy/lactation) and can directly compare an actual day's intake
 * (e.g. from analyze_meal_clinical/calculate_recipe_nutrition totals)
 * against RDA/AI/UL. Prefer this API-backed set for anything life-stage-
 * specific or intake-comparison related.
 *
 * Three tools:
 *   - dri_life_stages
 *   - dri_lookup
 *   - dri_compare_intake
 */

export function registerDriApiTools(server: McpServer) {
  // ── dri_life_stages ──────────────────────────────────────────────────────
  server.registerTool(
    "dri_life_stages",
    {
      title: "List DRI Life Stage Groups",
      description:
        "List every life-stage group the DRI tables have data for (code, label, sex, life_stage_type, age " +
        "range) — use a code from here with dri_lookup's life_stage parameter, or with dri_compare_intake.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safeTool("dri_life_stages", async () => {
      const res = await chakudyaClient.get("/dri/life-stages");
      return ok(res.data ?? res);
    })
  );

  // ── dri_lookup ───────────────────────────────────────────────────────────
  server.registerTool(
    "dri_lookup",
    {
      title: "Look Up Dietary Reference Intakes",
      description:
        "Look up EAR/RDA/AI/UL for one nutrient or every tracked nutrient, for a resolved life stage. " +
        "Resolve the life stage either by passing life_stage (a code from dri_life_stages — takes priority) " +
        "or by age (+ sex if age >= 9, + life_stage_type for pregnancy/lactation from age 14 up). Omit " +
        "'nutrient' to get every nutrient for that life stage plus the standard adult AMDR macronutrient " +
        "ranges and sodium chronic-disease-risk-reduction intake.",
      inputSchema: {
        life_stage: z.string().optional().describe("A code from dri_life_stages — takes priority over age/sex if both given"),
        nutrient: z.string().optional().describe("A nutrient key, e.g. 'calcium_mg', 'iron_mg', 'protein_g'. Omit for all tracked nutrients."),
        age: z.number().positive().optional().describe("Age in years, used only if life_stage is omitted"),
        sex: z.enum(["male", "female"]).optional().describe("Required with age if age >= 9"),
        life_stage_type: z.enum(["normal", "pregnancy", "lactation"]).optional().default("normal"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safeTool("dri_lookup", async ({ life_stage, nutrient, age, sex, life_stage_type }) => {
      const res = await chakudyaClient.get("/dri", { life_stage, nutrient, age, sex, life_stage_type });
      return ok(res.data ?? res);
    })
  );

  // ── dri_compare_intake ───────────────────────────────────────────────────
  server.registerTool(
    "dri_compare_intake",
    {
      title: "Compare Intake Against DRI Targets",
      description:
        "Compare an actual day's (or meal's) nutrient intake against a resolved life stage's RDA/AI " +
        "targets, flagging percent of target and whether the UL is exceeded. 'intake' uses the same field " +
        "names as calculate_recipe_nutrition/analyze_meal_clinical's total_nutrients (e.g. protein_g, " +
        "calcium_mg, vitc_mg) — pipe either straight in. Only nutrients both present in 'intake' and " +
        "tracked in the DRI tables are compared; others are listed as skipped with a reason. Resolve the " +
        "life stage the same way as dri_lookup (life_stage code, or age +/- sex/life_stage_type).",
      inputSchema: {
        intake: z.record(z.number()).describe("Nutrient totals to compare, e.g. { calcium_mg: 850, iron_mg: 12 }"),
        life_stage: z.string().optional().describe("A code from dri_life_stages — takes priority over age/sex if both given"),
        age: z.number().positive().optional(),
        sex: z.enum(["male", "female"]).optional(),
        life_stage_type: z.enum(["normal", "pregnancy", "lactation"]).optional().default("normal"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safeTool("dri_compare_intake", async ({ intake, life_stage, age, sex, life_stage_type }) => {
      const res = await chakudyaClient.post("/dri/compare", { intake, life_stage, age, sex, life_stage_type });
      return ok(res.data ?? res);
    })
  );
}
