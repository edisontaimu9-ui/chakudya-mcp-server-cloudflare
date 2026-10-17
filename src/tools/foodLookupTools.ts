import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { chakudyaClient } from "../clients/chakudyaClient.js";
import { ok, safeTool } from "../utils/toolResult.js";

/**
 * Food-composition lookups on chakudya-api that the older search_food/get_food_details tools do not use:
 *  - find_food: GET /foods/lookup, the intent-aware best match (e.g. a bare "rice" favours cooked), per-100 g
 *    values, with alternates when the match is not confident;
 *  - foods_by_category: GET /foods/by-category browse;
 *  - search_foods_advanced: GET /foods/search with brand and ingredient filters (typo/synonym tolerant,
 *    Chichewa <-> English aliases such as chinangwa/cassava).
 */
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

export function registerFoodLookupTools(server: McpServer) {
  server.registerTool(
    "find_food",
    {
      title: "Find a Food (best match, per-100 g composition)",
      description:
        "Look up ONE food by name (English or Chichewa, typos tolerated) and return its nutrient composition per 100 g from the Chakudya " +
        "Nutrition Registry: Malawi food composition table first, then cached/wider USDA, Open Food Facts and FatSecret data. Picks the best match " +
        "using the query's intent; if it was not confident it says so and lists alternates. Use this first when you need real nutrient values " +
        "(e.g. 'mgaiwa', 'ufa woyera', 'kondowole') before comparing foods or using a calculator. tier='wider' skips local data. For a list of candidates and ids use search_food; to filter by brand or ingredient use search_foods_advanced.",
      inputSchema: {
        query: z.string().min(1).optional().describe("Food name, e.g. 'mgaiwa' or 'rice cooked'"),
        barcode: z.string().min(8).max(14).optional(),
        tier: z.enum(["wider"]).optional().describe("Skip local data and use the wider USDA/OFF/FatSecret tier"),
        with_servings: z.boolean().optional().default(false).describe("Include the household serving sizes known for this food"),
      },
      annotations: READ,
    },
    safeTool("find_food", async ({ query, barcode, tier, with_servings }) => {
      if (!query && !barcode) throw new Error("Provide query or barcode.");
      const res = await chakudyaClient.get("/foods/lookup", { q: query, barcode, tier, with_servings: with_servings ? "true" : undefined });
      const meta = res as unknown as Record<string, unknown>;
      return ok(res.data, {
        source: meta.source,
        ambiguous: meta.ambiguous ?? false,
        ...(meta.alternates ? { alternates: meta.alternates, note: meta.note } : {}),
      });
    })
  );

  server.registerTool(
    "foods_by_category",
    {
      title: "Browse Foods by Category",
      description: "List foods in one Chakudya food category (no search text needed), e.g. a cereal, legume or vegetable category. Use foods_categories if you need the category list. To narrow a category by name use search_foods_advanced.",
      inputSchema: {
        category: z.string().min(1),
        max_results: z.number().int().min(1).max(100).optional().default(20),
      },
      annotations: READ,
    },
    safeTool("foods_by_category", async ({ category, max_results }) => {
      const res = await chakudyaClient.get("/foods/by-category", { category, max_results });
      return ok(res.data ?? res, { count: res.count, category });
    })
  );

  server.registerTool(
    "search_foods_advanced",
    {
      title: "Search Foods and Packaged Products (typo/synonym tolerant, brand and ingredient filters)",
      description:
        "Typo-tolerant search over the local foods table with Chichewa/English synonym expansion (chinangwa also finds cassava), plus packaged-product " +
        "search by brand or by an ingredient. Give any of query, category, brand or ingredient. Rows are tagged _source and _match_type so you can " +
        "tell what matched. Local data only; use find_food for the wider USDA/OFF/FatSecret tier. For a plain name search that returns ids use search_food.",
      inputSchema: {
        query: z.string().optional(),
        category: z.string().optional(),
        brand: z.string().optional(),
        ingredient: z.string().optional(),
        max_results: z.number().int().min(1).max(100).optional().default(20),
        min_similarity: z.number().min(0).max(1).optional(),
      },
      annotations: READ,
    },
    safeTool("search_foods_advanced", async ({ query, category, brand, ingredient, max_results, min_similarity }) => {
      if (!query && !category && !brand && !ingredient) throw new Error("Provide at least one of query, category, brand or ingredient.");
      const res = await chakudyaClient.get("/foods/search", { q: query, category, brand, ingredient, max_results, min_similarity });
      const meta = res as unknown as Record<string, unknown>;
      return ok(res.data ?? res, { count: res.count, ...(meta.expanded_terms ? { expanded_terms: meta.expanded_terms } : {}) });
    })
  );
}
