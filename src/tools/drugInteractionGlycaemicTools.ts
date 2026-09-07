import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { chakudyaClient } from "../clients/chakudyaClient.js";
import { ok, safeTool } from "../utils/toolResult.js";

/**
 * Two more pieces of the clinical nutrition layer, served straight from
 * reference tables on the Chakudya API: drug-nutrient interactions
 * (/drug-interactions, /drug-interactions/search) and published, sourced
 * glycaemic index/load data (/glycaemic-index) — the same table
 * compare_foods_nutrients (foodComparisonTools.ts) draws its glycaemic
 * figures from.
 *
 * Three tools:
 *   - list_drug_nutrient_interactions
 *   - search_drug_nutrient_interactions
 *   - glycaemic_index_reference
 */

export function registerDrugInteractionGlycaemicTools(server: McpServer) {
  // ── list_drug_nutrient_interactions ──────────────────────────────────────
  server.registerTool(
    "list_drug_nutrient_interactions",
    {
      title: "List Drug-Nutrient Interactions",
      description:
        "Browse the drug-nutrient interaction reference table, optionally filtered by category or " +
        "severity. Use search_drug_nutrient_interactions instead for a keyword search over drug/brand/" +
        "class/food/nutrient names.",
      inputSchema: {
        category: z.string().optional(),
        severity: z.string().optional(),
        limit: z.number().int().positive().max(100).optional().default(50),
        offset: z.number().int().nonnegative().optional().default(0),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safeTool("list_drug_nutrient_interactions", async ({ category, severity, limit, offset }) => {
      const res = await chakudyaClient.get("/drug-interactions", { category, severity, limit, offset });
      return ok(res.data ?? res);
    })
  );

  // ── search_drug_nutrient_interactions ────────────────────────────────────
  server.registerTool(
    "search_drug_nutrient_interactions",
    {
      title: "Search Drug-Nutrient Interactions",
      description:
        "Keyword search over the drug-nutrient interaction table. The query can be a drug name, brand " +
        "name, drug class, or a nutrient/food keyword (e.g. 'warfarin', 'grapefruit', 'vitamin B12') — " +
        "matches on any part of the entry, not just the drug name field.",
      inputSchema: {
        q: z.string().min(1).describe("Drug name, brand, class, or nutrient/food keyword"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safeTool("search_drug_nutrient_interactions", async ({ q }) => {
      const res = await chakudyaClient.get("/drug-interactions/search", { q });
      return ok(res.data ?? res);
    })
  );

  // ── glycaemic_index_reference ────────────────────────────────────────────
  server.registerTool(
    "glycaemic_index_reference",
    {
      title: "Glycaemic Index/Load Reference",
      description:
        "Browse the published, sourced glycaemic index/load reference table (optionally filtered by a " +
        "food-name search). Every entry cites a real source — nothing here is estimated. This is the same " +
        "table compare_foods_nutrients draws its glycaemic figures from; use this directly to browse what's " +
        "covered rather than only seeing it indirectly through a comparison.",
      inputSchema: {
        search: z.string().optional().describe("Optional food-name substring filter"),
        limit: z.number().int().positive().max(100).optional().default(50),
        offset: z.number().int().nonnegative().optional().default(0),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safeTool("glycaemic_index_reference", async ({ search, limit, offset }) => {
      const res = await chakudyaClient.get("/glycaemic-index", { search, limit, offset });
      return ok(res.data ?? res);
    })
  );
}
