import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { chakudyaClient } from "../clients/chakudyaClient.js";
import { ok, safeTool } from "../utils/toolResult.js";

/**
 * Food substitution suggestions (GET /foods/substitutes) and side-by-side
 * nutrient comparison across 2-6 foods (GET /foods/compare), including
 * sourced glycaemic index/load figures where available.
 *
 * Two tools:
 *   - find_food_substitutes
 *   - compare_foods_nutrients
 */

export function registerFoodComparisonTools(server: McpServer) {
  // ── find_food_substitutes ────────────────────────────────────────────────
  server.registerTool(
    "find_food_substitutes",
    {
      title: "Find Food Substitutes",
      description:
        "Resolve a food, classify it into a Malawi-relevant substitution group (e.g. staple grains, " +
        "legumes, animal protein), and return the closest alternatives from that same group — ranked purely " +
        "by closeness in the group's primary nutrient per 100g (e.g. protein for protein-group foods), each " +
        "with a per-100g comparison against the original. Does NOT know about cost, local availability, " +
        "taste, or portion size — nutritional closeness only.",
      inputSchema: {
        food_name: z.string().min(1),
        limit: z.number().int().positive().max(15).optional().default(5),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safeTool("find_food_substitutes", async ({ food_name, limit }) => {
      const res = await chakudyaClient.get("/foods/substitutes", { food_name, limit });
      return ok(res.data ?? res);
    })
  );

  // ── compare_foods_nutrients ──────────────────────────────────────────────
  server.registerTool(
    "compare_foods_nutrients",
    {
      title: "Compare Foods Side-by-Side",
      description:
        "Compare 2-6 foods side-by-side: per-100g energy/macros/full micronutrient panel for each, plus a " +
        "nutrient-by-nutrient pivot flagging which food is highest/lowest for each. Where a published, " +
        "sourced glycaemic index/load value exists for a food, it's included (GI/GL is never estimated — a " +
        "food without a sourced entry gets a clearly-labelled qualitative fiber/carb heuristic instead, " +
        "never a made-up number).",
      inputSchema: {
        food_names: z.array(z.string().min(1)).min(2).max(6).describe("2-6 food names to compare, e.g. ['nsima', 'rice', 'potatoes']"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safeTool("compare_foods_nutrients", async ({ food_names }) => {
      const res = await chakudyaClient.get("/foods/compare", { foods: food_names.join(",") });
      return ok(res.data ?? res);
    })
  );
}
