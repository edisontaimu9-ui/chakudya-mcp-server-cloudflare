import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { chakudyaClient } from "../clients/chakudyaClient.js";
import { ok, safeTool } from "../utils/toolResult.js";

/**
 * Recipe nutrition calculation (POST /recipes/calculate), clinical meal
 * analysis (POST /meals/analyze), and free-text ingredient parsing
 * (POST /ingredients/parse). Builds on the same ingredient-resolution
 * pipeline as analyze_meal in foodTools.ts, but these three additionally
 * cover: yield-per-serving + a generated nutrition label (recipes), and
 * macronutrient-% + food-group coverage + clinical condition/allergen
 * screening + daily-target comparison (meals) — analyze_meal in
 * foodTools.ts stays the simpler "just give me totals" tool.
 *
 * Three tools:
 *   - calculate_recipe_nutrition
 *   - analyze_meal_clinical
 *   - parse_ingredients_text
 */

const INGREDIENT_ITEM = z.object({
  food_id: z.union([z.string(), z.number()]).optional(),
  food_name: z.string().optional(),
  quantity: z.number().positive().describe("Amount in the given unit (defaults to grams if unit is omitted)"),
  unit: z.string().optional().describe("Unit for quantity, e.g. 'g', 'cup', 'tbsp'. Defaults to grams if omitted."),
});

const CLINICAL_CONDITIONS = [
  "diabetes",
  "hypertension",
  "kidney_disease",
  "pregnancy",
  "paediatric",
  "anaemia",
  "food_allergy",
] as const;

const ALLERGENS = [
  "peanut",
  "tree_nut",
  "dairy",
  "egg",
  "soy",
  "wheat_gluten",
  "fish",
  "shellfish",
  "sesame",
] as const;

export function registerRecipeMealTools(server: McpServer) {
  // ── calculate_recipe_nutrition ───────────────────────────────────────────
  server.registerTool(
    "calculate_recipe_nutrition",
    {
      title: "Calculate Recipe Nutrition",
      description:
        "Given a recipe's ingredients (each with quantity and optional unit) and how many servings it " +
        "yields, resolve every ingredient (local database first, then the registry's wider data tier), sum " +
        "nutrients across the whole recipe, and divide by servings to get per-serving figures plus a " +
        "generated nutrition label. Each ingredient needs food_id or food_name plus quantity; unit " +
        "defaults to grams if omitted.",
      inputSchema: {
        ingredients: z.array(INGREDIENT_ITEM).min(1),
        servings: z.number().positive().optional().default(1),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safeTool("calculate_recipe_nutrition", async ({ ingredients, servings }) => {
      const res = await chakudyaClient.post("/recipes/calculate", { ingredients, servings });
      return ok(res.data ?? res);
    })
  );

  // ── analyze_meal_clinical ────────────────────────────────────────────────
  server.registerTool(
    "analyze_meal_clinical",
    {
      title: "Analyze a Meal (Clinical Layer)",
      description:
        "Analyze a single eaten meal's ingredients for: macronutrient breakdown (kcal and % from protein/" +
        "carbs/fat, Atwater 4/4/9, compared against the standard adult AMDR range), which core food groups " +
        "(Grains/Legumes/Protein/Vegetables/Fruits/Dairy) are present vs missing, and — if 'conditions' is " +
        "supplied — meal-level clinical screening flags for diabetes, hypertension, kidney_disease, " +
        "pregnancy, paediatric, anaemia, and/or food_allergy (allergens[] required when 'food_allergy' is " +
        "included). If 'daily_targets' is supplied (kcal/protein_g/carbs_g/fat_g), also compares this " +
        "meal's totals against those. Purely descriptive — never invents a personalized target itself; " +
        "flags are for a clinician/patient to weigh, not a diagnosis or prescription.",
      inputSchema: {
        meal_type: z.string().optional().describe("e.g. 'breakfast', 'lunch', 'dinner', 'snack' — descriptive only"),
        ingredients: z.array(INGREDIENT_ITEM).min(1),
        daily_targets: z
          .object({
            kcal: z.number().positive().optional(),
            protein_g: z.number().positive().optional(),
            carbs_g: z.number().positive().optional(),
            fat_g: z.number().positive().optional(),
          })
          .optional()
          .describe("Optional caller-supplied daily targets to compare this meal against — never inferred here from age/sex/weight."),
        conditions: z.array(z.enum(CLINICAL_CONDITIONS)).optional(),
        allergens: z.array(z.enum(ALLERGENS)).optional().describe("Required if conditions includes 'food_allergy'"),
        age: z.number().positive().optional(),
        sex: z.enum(["male", "female"]).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safeTool(
      "analyze_meal_clinical",
      async ({ meal_type, ingredients, daily_targets, conditions, allergens, age, sex }) => {
        const res = await chakudyaClient.post("/meals/analyze", {
          meal_type,
          ingredients,
          daily_targets,
          conditions,
          allergens,
          age,
          sex,
        });
        return ok(res.data ?? res);
      }
    )
  );

  // ── parse_ingredients_text ───────────────────────────────────────────────
  server.registerTool(
    "parse_ingredients_text",
    {
      title: "Parse Free-Text Ingredients",
      description:
        "Parse a free-text description of ingredients (e.g. '2 eggs, 1 cup rice, 100g chicken and half an " +
        "avocado') into a structured ingredients[] list (food_name, quantity, unit) suitable for feeding " +
        "straight into calculate_recipe_nutrition or analyze_meal_clinical. Uses an LLM on the Chakudya API " +
        "side — quality depends on how clearly the text describes discrete food items and amounts.",
      inputSchema: {
        text: z.string().min(1),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    safeTool("parse_ingredients_text", async ({ text }) => {
      const res = await chakudyaClient.post("/ingredients/parse", { text });
      return ok(res.data ?? res);
    })
  );
}
