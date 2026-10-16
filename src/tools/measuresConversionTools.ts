import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { chakudyaClient } from "../clients/chakudyaClient.js";
import { ok, safeTool } from "../utils/toolResult.js";

/**
 * Household/standard measure conversion on chakudya-api: GET /measures (catalogue),
 * GET /measures/convert (unit to unit) and GET /foods/convert (one food, one amount, either way
 * round: cups/spoons/chipande to grams, or grams to household measures, with nutrients).
 */
export function registerMeasuresConversionTools(server: McpServer) {
  server.registerTool(
    "measures_catalog",
    {
      title: "Household and Standard Measures Catalogue",
      description:
        "List every unit Chakudya understands (cups, spoons, scoops, chipande, g, ml, oz...), the printed reference tables " +
        "and scoop sizes. Optional section: units | scoop_sizes | reference_tables | sources.",
      inputSchema: { section: z.enum(["units", "scoop_sizes", "reference_tables", "sources"]).optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safeTool("measures_catalog", async ({ section }) => {
      const res = await chakudyaClient.get("/measures", { section });
      return ok(res.data ?? res);
    })
  );

  server.registerTool(
    "measures_convert",
    {
      title: "Convert Between Measures (no food)",
      description:
        "Convert an amount from one unit to another (e.g. 3 tbsp to ml). Volume converts to volume and weight to weight; " +
        "for grams of a food to cups use food_convert. Leave 'to' empty to get every unit of the same kind.",
      inputSchema: {
        amount: z.union([z.number().nonnegative(), z.string()]).describe("A number or fraction such as 0.5 or '1/2'"),
        from: z.string().min(1).describe("Source unit, e.g. 'tbsp', 'cup', 'g'"),
        to: z.string().optional().describe("Target unit; omit for all units of the same kind"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safeTool("measures_convert", async ({ amount, from, to }) => {
      const res = await chakudyaClient.get("/measures/convert", { amount: String(amount), from, to });
      return ok(res.data ?? res);
    })
  );

  server.registerTool(
    "food_convert",
    {
      title: "Convert a Food Amount (household <-> weight) with Nutrients",
      description:
        "For one food and one amount, convert household measures (cup, tbsp, scoop 16, chipande, piece...) to standard weight, or " +
        "weight/volume to household equivalents, and return the nutrients for that amount. Give food_name or food_id. " +
        "Cup means 250 ml; use 'us cup' for 240 ml. When the food has no cup/spoon serving on file, water density is assumed and flagged.",
      inputSchema: {
        food_name: z.string().min(1).optional().describe("Food name, e.g. 'maize flour'"),
        food_id: z.number().int().positive().optional(),
        amount: z.union([z.number().positive(), z.string()]).optional().default(1),
        unit: z.string().optional().default("g").describe("e.g. g, kg, cup, tbsp, chipande, piece"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safeTool("food_convert", async ({ food_name, food_id, amount, unit }) => {
      if (food_id === undefined && !food_name) throw new Error("Provide food_name or food_id.");
      const res =
        food_id !== undefined
          ? await chakudyaClient.get(`/foods/${food_id}/convert`, { amount: String(amount), unit })
          : await chakudyaClient.get("/foods/convert", { q: food_name, amount: String(amount), unit });
      return ok(res.data ?? res);
    })
  );
}
