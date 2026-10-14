import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, safeTool } from "../utils/toolResult.js";

// Activity factors for the Mifflin-St Jeor TDEE calculation.
const ACTIVITY_FACTORS = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  very_active: 1.9,
} as const;

export function registerClinicalTools(server: McpServer) {
  // ── nutrition_calculator ─────────────────────────────────────────────────
  server.registerTool(
    "nutrition_calculator",
    {
      title: "Nutrition Calculator (BMI / BMR / TDEE)",
      description:
        "Compute BMI, Basal Metabolic Rate (Mifflin-St Jeor equation), and Total Daily Energy Expenditure " +
        "from weight, height, age, sex, and activity level. Pure calculation — does not call the CNR API. " +
        "Educational/clinical-support estimate only, not a substitute for individualized dietetic assessment.",
      inputSchema: {
        weight_kg: z.number().positive(),
        height_cm: z.number().positive(),
        age_years: z.number().positive(),
        sex: z.enum(["male", "female"]),
        activity_level: z
          .enum(["sedentary", "light", "moderate", "active", "very_active"])
          .optional()
          .default("sedentary")
          .describe(
            "sedentary=little/no exercise, light=1-3 days/wk, moderate=3-5 days/wk, " +
              "active=6-7 days/wk, very_active=hard daily exercise or physical job"
          ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    safeTool(
      "nutrition_calculator",
      async ({ weight_kg, height_cm, age_years, sex, activity_level }) => {
        const heightM = height_cm / 100;
        const bmi = Math.round((weight_kg / (heightM * heightM)) * 10) / 10;

        let bmiCategory = "normal";
        if (bmi < 18.5) bmiCategory = "underweight";
        else if (bmi >= 25 && bmi < 30) bmiCategory = "overweight";
        else if (bmi >= 30) bmiCategory = "obese";

        // Mifflin-St Jeor
        const bmr =
          sex === "male"
            ? 10 * weight_kg + 6.25 * height_cm - 5 * age_years + 5
            : 10 * weight_kg + 6.25 * height_cm - 5 * age_years - 161;

        const tdee = bmr * ACTIVITY_FACTORS[activity_level];

        return ok({
          bmi: bmi,
          bmi_category: bmiCategory,
          bmr_kcal_per_day: Math.round(bmr),
          tdee_kcal_per_day: Math.round(tdee),
          formula: "Mifflin-St Jeor",
          activity_level,
          disclaimer:
            "Estimate only. Does not account for illness state, body composition, pregnancy, or " +
            "clinical condition (e.g. burns, critical illness) — use appropriate stress/injury factors " +
            "and clinical judgement for patient care decisions.",
        });
      }
    )
  );
}
