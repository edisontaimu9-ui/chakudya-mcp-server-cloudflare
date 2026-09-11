import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { chakudyaClient, ChakudyaApiError } from "../clients/chakudyaClient.js";
import { ok, safeTool } from "../utils/toolResult.js";
import { logger } from "../utils/logger.js";

/** Per-100g/ml nutrient shape returned by every CNR food source. */
interface CnrFood {
  id?: string | number;
  food_name: string;
  category?: string | null;
  // Local Malawi FCT rows (from /foods, /foods/:id) store calories as `kcal`;
  // only the /foods/lookup external-cascade fallback normalizes to
  // `energy_kcal`. Accept both and prefer whichever is present.
  energy_kcal?: number | null;
  kcal?: number | null;
  protein_g?: number | null;
  fat_g?: number | null;
  carbs_g?: number | null;
  fiber_g?: number | null;
  sodium_mg?: number | null;
  [key: string]: unknown;
}

const NUTRIENT_KEYS = ["energy_kcal", "protein_g", "fat_g", "carbs_g", "fiber_g", "sodium_mg"] as const;

/** Fills in `energy_kcal` from the local `kcal` column when the API hasn't
 * already normalized it (see CnrFood comment above). Leaves everything else
 * untouched. */
function normalizeFood(food: CnrFood): CnrFood {
  return { ...food, energy_kcal: food.energy_kcal ?? food.kcal ?? null };
}

function scaleNutrients(food: CnrFood, grams: number) {
  const factor = grams / 100;
  const scaled: Record<string, number | null> = {};
  for (const key of NUTRIENT_KEYS) {
    const val = key === "energy_kcal" ? food.energy_kcal ?? food.kcal : food[key];
    scaled[key] = typeof val === "number" ? Math.round(val * factor * 100) / 100 : null;
  }
  return scaled;
}

/** Resolves a food by numeric id, or by name via /foods search when id isn't given. */
async function resolveFood(input: { food_id?: string | number; food_name?: string }): Promise<CnrFood> {
  if (input.food_id !== undefined && input.food_id !== null && input.food_id !== "") {
    const res = await chakudyaClient.get<CnrFood>(`/foods/${input.food_id}`);
    if (!res.data) throw new ChakudyaApiError("Food id not found", 404, "/foods/:id", null);
    return normalizeFood(res.data);
  }
  if (input.food_name) {
    const res = await chakudyaClient.get<CnrFood[]>("/foods", { search: input.food_name, limit: 1 });
    const first = Array.isArray(res.data) ? res.data[0] : undefined;
    if (!first) {
      throw new ChakudyaApiError(
        `No food matching "${input.food_name}" found in the local database`,
        404,
        "/foods",
        null
      );
    }
    return normalizeFood(first);
  }
  throw new ChakudyaApiError("Provide either food_id or food_name", 400, "/foods", null);
}

export function registerFoodTools(server: McpServer) {
  // ── search_food ──────────────────────────────────────────────────────────
  server.registerTool(
    "search_food",
    {
      title: "Search Food",
      description:
        "Search the Chakudya Nutrition Registry (Malawi food composition database) by name. Three tiers, " +
        "same order as the Chakudya API's own internal lookup cascade: (1) exact/substring match in the " +
        "local database, (2) typo-tolerant fuzzy match against the local database (handles misspellings " +
        "like 'Chinagwa' for 'Chinangwa', or a plain English name against a Chichewa-labelled entry), " +
        "(3) external lookup cascade (USDA FoodData Central / Open Food Facts / FatSecret) for foods not " +
        "in the local database at all. Use this to find a food before calling get_food_details or " +
        "calculate_nutrients.",
      inputSchema: {
        query: z.string().min(1).describe("Food name to search for, e.g. 'nsima' or 'banana'"),
        category: z.string().optional().describe("Optional category filter — only applies to the exact/substring tier"),
        limit: z.number().int().positive().max(100).optional().default(10),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safeTool("search_food", async ({ query, category, limit }) => {
      const local = await chakudyaClient.get<CnrFood[]>("/foods", { search: query, category, limit });
      const localResults = Array.isArray(local.data) ? local.data.map(normalizeFood) : [];
      if (localResults.length > 0) {
        return ok(localResults, { source: "local_database", count: localResults.length });
      }

      // Tier 2 — typo-tolerant fuzzy match (pg_trgm word_similarity +
      // levenshtein tiebreak, local database only). Catches misspellings
      // and Chichewa/English name mismatches that a plain ilike substring
      // search (tier 1, above) can't, before paying the cost of an
      // external API cascade call.
      try {
        const fuzzy = await chakudyaClient.get<CnrFood[]>("/foods/search", { q: query, max_results: limit });
        const fuzzyResults = Array.isArray(fuzzy.data) ? fuzzy.data.map(normalizeFood) : [];
        if (fuzzyResults.length > 0) {
          return ok(fuzzyResults, {
            source: "local_database_fuzzy_match",
            count: fuzzyResults.length,
            note: "No exact match — these are the closest typo-tolerant matches in the local database.",
          });
        }
      } catch (e) {
        // A fuzzy-search failure shouldn't block falling through to the
        // external cascade below — log via rethrow only on unexpected
        // (non-404) errors, same pattern as the external-fallback catch.
        if (!(e instanceof ChakudyaApiError) || e.status !== 404) {
          logger.warn("fuzzy_food_search_failed", { query, error: e instanceof Error ? e.message : String(e) });
        }
      }

      // Tier 3 — external cascade for foods not in CNR's local database at all.
      // Note: /foods/lookup returns a single best-match object under `data`
      // (not an array, unlike /foods), so normalize both shapes here.
      try {
        const fallback = await chakudyaClient.get<CnrFood[] | CnrFood>("/foods/lookup", { q: query });
        const raw = fallback.data;
        const fallbackResults = Array.isArray(raw)
          ? raw.map(normalizeFood)
          : raw
            ? [normalizeFood(raw)]
            : [];
        return ok(fallbackResults, {
          source: "external_fallback",
          note: "Not found locally (exact or fuzzy); retrieved via USDA/OpenFoodFacts/FatSecret cascade and cached for next time.",
        });
      } catch (e) {
        if (e instanceof ChakudyaApiError && e.status === 404) {
          return ok([], { source: "none", message: `No match for "${query}" in local (exact or fuzzy) or external sources.` });
        }
        throw e;
      }
    })
  );

  // ── get_food_details ────────────────────────────────────────────────────
  server.registerTool(
    "get_food_details",
    {
      title: "Get Food Details",
      description:
        "Fetch full details (per-100g/ml nutrients, category) for a single food by its Chakudya database id. " +
        "Use search_food first to find the id.",
      inputSchema: {
        food_id: z.union([z.string(), z.number()]).describe("The CNR food id from search_food"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safeTool("get_food_details", async ({ food_id }) => {
      const res = await chakudyaClient.get<CnrFood>(`/foods/${food_id}`);
      return ok(res.data ? normalizeFood(res.data) : res.data);
    })
  );

  // ── calculate_nutrients ──────────────────────────────────────────────────
  server.registerTool(
    "calculate_nutrients",
    {
      title: "Calculate Nutrients For A Quantity",
      description:
        "Calculate the actual nutrient content of a specific quantity of one food, scaling from the " +
        "database's per-100g/100ml values. Provide either food_id (preferred, from search_food) or " +
        "food_name (will be resolved via search). All CNR nutrient values are per 100g/100ml, so this " +
        "tool does the grams-based scaling for you.",
      inputSchema: {
        food_id: z.union([z.string(), z.number()]).optional(),
        food_name: z.string().optional(),
        quantity_grams: z
          .number()
          .positive()
          .describe("Quantity actually consumed, in grams (or ml for liquids)"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safeTool("calculate_nutrients", async ({ food_id, food_name, quantity_grams }) => {
      const food = await resolveFood({ food_id, food_name });
      const scaled = scaleNutrients(food, quantity_grams);
      return ok(
        { food_name: food.food_name, quantity_grams, nutrients: scaled },
        { basis: "per_100g_or_ml_scaled", source_food_id: food.id ?? null }
      );
    })
  );

  // ── analyze_meal ─────────────────────────────────────────────────────────
  server.registerTool(
    "analyze_meal",
    {
      title: "Analyze A Meal (Multiple Foods)",
      description:
        "Given a list of foods and quantities making up a meal, resolve each food in the CNR database, " +
        "scale its nutrients to the quantity eaten, and return both the per-item breakdown and the " +
        "meal-level totals (energy, protein, fat, carbs, fiber, sodium). Each item needs either food_id " +
        "or food_name plus quantity_grams.",
      inputSchema: {
        items: z
          .array(
            z.object({
              food_id: z.union([z.string(), z.number()]).optional(),
              food_name: z.string().optional(),
              quantity_grams: z.number().positive(),
            })
          )
          .min(1)
          .describe("Foods making up the meal"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safeTool("analyze_meal", async ({ items }) => {
      const sums: Record<string, number> = {
        energy_kcal: 0,
        protein_g: 0,
        fat_g: 0,
        carbs_g: 0,
        fiber_g: 0,
        sodium_mg: 0,
      };
      // Tracks, per nutrient, whether ANY item in the meal actually had a
      // measured (non-null) value for it. A nutrient with no contributing
      // data anywhere in the meal reports as null in totals — not 0 — so a
      // meal built entirely from foods with unentered micronutrients (see
      // Likuni Phala/milk test, 2026-09-02) doesn't read as "measured zero
      // fiber" when the true answer is "not yet in the database."
      const hasData: Record<string, boolean> = {
        energy_kcal: false,
        protein_g: false,
        fat_g: false,
        carbs_g: false,
        fiber_g: false,
        sodium_mg: false,
      };
      const breakdown: unknown[] = [];
      const warnings: string[] = [];

      for (const item of items) {
        try {
          const food = await resolveFood(item);
          const scaled = scaleNutrients(food, item.quantity_grams);
          breakdown.push({ food_name: food.food_name, quantity_grams: item.quantity_grams, nutrients: scaled });
          for (const key of NUTRIENT_KEYS) {
            const v = scaled[key];
            if (typeof v === "number") {
              sums[key] += v;
              hasData[key] = true;
            }
          }
        } catch (e) {
          const label = item.food_name ?? item.food_id ?? "unknown item";
          warnings.push(`Skipped "${label}": ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      const totals: Record<string, number | null> = {};
      for (const key of Object.keys(sums)) {
        totals[key] = hasData[key] ? Math.round(sums[key] * 100) / 100 : null;
      }

      return ok(
        { totals, items: breakdown },
        { basis: "per_100g_or_ml_scaled", warnings: warnings.length ? warnings : undefined }
      );
    })
  );

  // ── barcode_lookup ───────────────────────────────────────────────────────
  server.registerTool(
    "barcode_lookup",
    {
      title: "Packaged Product Lookup",
      description:
        "Look up a packaged food product by barcode (EAN/UPC) and/or free-text product name. Checks the " +
        "community-submitted packaged foods table first, then falls back to the external cascade " +
        "(USDA FoodData Central / Open Food Facts / FatSecret) via the CNR foods/lookup route. At least " +
        "one of barcode or query must be provided.",
      inputSchema: {
        barcode: z.string().min(6).optional().describe("The product barcode, digits only"),
        query: z.string().optional().describe("Free-text product name to search for"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safeTool("barcode_lookup", async ({ barcode, query }) => {
      if (!barcode && !query) {
        throw new ChakudyaApiError("Provide at least one of: barcode, query", 400, "/packaged", null);
      }

      const packaged = await chakudyaClient.get("/packaged", { barcode, search: query, limit: 5 });
      const packagedResults = Array.isArray(packaged.data) ? packaged.data : [];
      if (packagedResults.length > 0) {
        return ok(packagedResults, { source: "community_packaged_foods" });
      }

      try {
        const fallback = await chakudyaClient.get("/foods/lookup", { barcode, q: query });
        return ok(fallback.data ?? [], { source: "external_fallback" });
      } catch (e) {
        if (e instanceof ChakudyaApiError && e.status === 404) {
          return ok([], { message: `No product found for ${barcode ? `barcode ${barcode}` : `"${query}"`}` });
        }
        throw e;
      }
    })
  );

  // ── packaged_food_search ─────────────────────────────────────────────────
  server.registerTool(
    "packaged_food_search",
    {
      title: "Packaged Food Search",
      description:
        "Search packaged/branded food products. Pass a barcode for an exact lookup, and/or a free-text " +
        "query to search by product name (substring match). At least one of barcode or query must be " +
        "provided.",
      inputSchema: {
        query: z.string().optional().describe("Free-text product name search"),
        barcode: z.string().optional(),
        limit: z.number().int().positive().max(50).optional().default(10),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safeTool("packaged_food_search", async ({ query, barcode, limit }) => {
      if (!query && !barcode) {
        throw new ChakudyaApiError("Provide at least one of: query, barcode", 400, "/packaged", null);
      }
      const res = await chakudyaClient.get("/packaged", { barcode, search: query, limit });
      return ok(res.data ?? [], { source: "community_packaged_foods" });
    })
  );

  // ── foods_autocomplete ───────────────────────────────────────────────────
  server.registerTool(
    "foods_autocomplete",
    {
      title: "Food Search Autocomplete",
      description:
        "Search-as-you-type suggestions for a partial food name (e.g. 'chic' -> 'chicken breast', " +
        "'chicken soup'). Wraps FatSecret's Premier-only autocomplete endpoint on the Chakudya API side — " +
        "returns a 503-derived error on deployments without FATSECRET_CONSUMER_KEY/SECRET configured on a " +
        "Premier or Premier Free plan. Use search_food instead for the primary, always-available search.",
      inputSchema: {
        query: z.string().min(1).describe("Partial search expression, e.g. 'chic'"),
        max_results: z.number().int().positive().max(10).optional().default(4),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safeTool("foods_autocomplete", async ({ query, max_results }) => {
      const res = await chakudyaClient.get<string[]>("/foods/autocomplete", { q: query, max_results });
      return ok(res.data ?? []);
    })
  );

  // ── foods_categories ─────────────────────────────────────────────────────
  server.registerTool(
    "foods_categories",
    {
      title: "Food Category List",
      description:
        "List the standard food category reference list (near-static, cached 24h server-side). Wraps " +
        "FatSecret's Premier-only food_categories endpoint on the Chakudya API side — returns a " +
        "503-derived error on deployments without FATSECRET_CONSUMER_KEY/SECRET configured on a Premier " +
        "or Premier Free plan.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safeTool("foods_categories", async () => {
      const res = await chakudyaClient.get("/foods/categories");
      return ok(res.data ?? []);
    })
  );

  // ── get_food_serving_sizes ───────────────────────────────────────────────
  server.registerTool(
    "get_food_serving_sizes",
    {
      title: "Get Realistic Serving Sizes For A Food",
      description:
        "Get realistic Malawian household serving sizes for a food (e.g. '1 medium nsima ball — 350g'), " +
        "each with nutrients pre-scaled from the database's 100g/100ml basis, so no manual grams math is " +
        "needed. Three tiers, most authoritative first: the food's own Malawi FCT household-measure entry, " +
        "a locally-curated keyword match for that specific food, or a generic category fallback — the raw " +
        "100g/100ml reference is always included too. Use search_food first to find the food_id.",
      inputSchema: {
        food_id: z.union([z.string(), z.number()]).describe("The CNR food id from search_food"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safeTool("get_food_serving_sizes", async ({ food_id }) => {
      const res = await chakudyaClient.get<CnrFood>(`/foods/${food_id}`, { with_servings: true });
      const food = res.data;
      if (!food) return ok({ serving_sizes: [] });
      return ok({
        food_id: food.id ?? food_id,
        food_name: food.food_name,
        serving_sizes: (food as { serving_sizes?: unknown }).serving_sizes ?? [],
      });
    })
  );

  // ── generate_nutrition_label ─────────────────────────────────────────────
  server.registerTool(
    "generate_nutrition_label",
    {
      title: "Generate a Nutrition Facts Label",
      description:
        "Generate a formatted Nutrition Facts label for a food, scaled to a chosen serving size (falls back " +
        "to the most authoritative serving_sizes entry — see get_food_serving_sizes — if 'serving' isn't " +
        "given or doesn't match). Returns the label plus the alternate servings it could have been built " +
        "from. Use search_food first to find the food_id.",
      inputSchema: {
        food_id: z.union([z.string(), z.number()]).describe("The CNR food id from search_food"),
        serving: z
          .string()
          .optional()
          .describe("Optional case-insensitive substring to pick a specific serving label (e.g. 'cup', '100g'); omit for the default"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safeTool("generate_nutrition_label", async ({ food_id, serving }) => {
      const res = await chakudyaClient.get(`/foods/${food_id}/label`, { serving });
      return ok(res.data ?? res, {
        food_id: (res as { food_id?: unknown }).food_id,
        food_name: (res as { food_name?: unknown }).food_name,
        serving_source: (res as { serving_source?: unknown }).serving_source,
        alternate_servings: (res as { alternate_servings?: unknown }).alternate_servings,
      });
    })
  );
}
