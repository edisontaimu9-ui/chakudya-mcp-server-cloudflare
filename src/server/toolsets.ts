import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerFoodTools } from "../tools/foodTools.js";
import { registerClinicalTools } from "../tools/clinicalTools.js";
import { registerRagTools } from "../tools/ragTools.js";
import { registerEducationTools } from "../tools/educationTools.js";
import { registerPediatricTools } from "../tools/pediatricTools.js";
import { registerEnergyExpenditureTools } from "../tools/energyExpenditureTools.js";
import { registerWhoGrowthTools } from "../tools/whoGrowthTools.js";
import { registerNacsClassificationTools } from "../tools/nacsClassificationTools.js";
import { registerAspenRefeedingTools } from "../tools/aspenRefeedingTools.js";
import { registerGlimMalnutritionTools } from "../tools/glimMalnutritionTools.js";
import { registerSgaAssessmentTools } from "../tools/sgaAssessmentTools.js";
import { registerBurnNutritionTools } from "../tools/burnNutritionTools.js";
import { registerPediatricBurnTools } from "../tools/pediatricBurnTools.js";
import { registerClinicalNutritionAssessmentTools } from "../tools/clinicalNutritionAssessmentTools.js";
import { registerAdjustedBodyWeightTools } from "../tools/adjustedBodyWeightTools.js";
import { registerIndicationEnergyProteinTools } from "../tools/indicationEnergyProteinTools.js";
import { registerHarrisBenedictStressFactorTools } from "../tools/harrisBenedictStressFactorTools.js";
import { registerCriticalCareNutritionSupportTools } from "../tools/criticalCareNutritionSupportTools.js";
import { registerStatureEstimationTools } from "../tools/statureEstimationTools.js";
import { registerWeightEstimationTools } from "../tools/weightEstimationTools.js";
import { registerBodyWeightAdjustmentTools } from "../tools/bodyWeightAdjustmentTools.js";
import { registerAnthropometricClassificationTools } from "../tools/anthropometricClassificationTools.js";
import { registerDietaryReferenceIntakeTables } from "../tools/dietaryReferenceIntakeTables.js";
import { registerClinicalReferenceRangesTools } from "../tools/clinicalReferenceRangesTools.js";
import { registerCarbCountingDoseAdjustmentTools } from "../tools/carbCountingDoseAdjustmentTools.js";
import { registerUserDataTools } from "../tools/userDataTools.js";
import { registerMemoryTools } from "../tools/memoryTools.js";
import { registerPackagedSubmissionTools } from "../tools/packagedSubmissionTools.js";
import { registerRecipeMealTools } from "../tools/recipeMealTools.js";
import { registerFoodLogTools } from "../tools/foodLogTools.js";
import { registerDriApiTools } from "../tools/driApiTools.js";
import { registerFoodComparisonTools } from "../tools/foodComparisonTools.js";
import { registerDrugInteractionGlycaemicTools } from "../tools/drugInteractionGlycaemicTools.js";
import { registerUnder5MalnutritionScreeningTools } from "../tools/under5MalnutritionScreeningTools.js";
import { registerPregnantPostpartumScreeningTools } from "../tools/pregnantPostpartumScreeningTools.js";
import { registerBmiForAgeTools } from "../tools/bmiForAgeTools.js";
import { registerSchoolAgeScreeningTools } from "../tools/schoolAgeScreeningTools.js";
import { registerAdultScreeningTools } from "../tools/adultScreeningTools.js";
import { registerPediatricAssessmentTools } from "../tools/pediatricAssessmentTools.js";
import { registerIntergrowthPretermGrowthTools } from "../tools/intergrowthPretermGrowthTools.js";
import { registerFentonPretermTools } from "../tools/fentonPretermTools.js";
import { registerGrowthAssessTools } from "../tools/growthAssessTools.js";
import { registerMeasuresConversionTools } from "../tools/measuresConversionTools.js";
import { registerEnergyEngineTools } from "../tools/energyEngineTools.js";
import { registerFhirNcpTools } from "../tools/fhirNcpTools.js";
import { registerFoodLookupTools } from "../tools/foodLookupTools.js";

type Register = (server: McpServer, sessionId?: string) => void;

/**
 * Named groups of tools. Every register function appears in exactly one group
 * (src/server/__tests__/toolsets.test.ts enforces this), so `?toolset=` can
 * narrow what a client loads, while no toolset means everything, as before.
 */
export const TOOLSETS: Record<string, { description: string; register: Register[] }> = {
  food: {
    description: "Food composition lookups, packaged foods, recipes, meals, measures and food comparison",
    register: [registerFoodTools, registerFoodLookupTools, registerFoodComparisonTools, registerRecipeMealTools, registerMeasuresConversionTools, registerPackagedSubmissionTools],
  },
  user: {
    description: "Food log, favourites, history and session memory",
    register: [registerUserDataTools, registerFoodLogTools, (s, id) => registerMemoryTools(s, id)],
  },
  knowledge: {
    description: "RAG search over guidelines, evidence retrieval and education tools",
    register: [registerRagTools, registerEducationTools],
  },
  energy: {
    description: "Energy and protein requirements, energy expenditure and critical care nutrition support",
    register: [registerEnergyExpenditureTools, registerEnergyEngineTools, registerIndicationEnergyProteinTools, registerHarrisBenedictStressFactorTools, registerCriticalCareNutritionSupportTools],
  },
  clinical: {
    description: "Adult clinical calculators, body weight and stature estimates, reference ranges, DRI, malnutrition diagnosis, refeeding, diabetes, drug interactions and FHIR",
    register: [
      registerClinicalTools, registerClinicalNutritionAssessmentTools, registerAdjustedBodyWeightTools, registerBodyWeightAdjustmentTools,
      registerStatureEstimationTools, registerWeightEstimationTools, registerAnthropometricClassificationTools, registerClinicalReferenceRangesTools,
      registerDietaryReferenceIntakeTables, registerDriApiTools, registerNacsClassificationTools, registerAspenRefeedingTools,
      registerGlimMalnutritionTools, registerSgaAssessmentTools, registerCarbCountingDoseAdjustmentTools, registerDrugInteractionGlycaemicTools, registerFhirNcpTools,
    ],
  },
  screening: {
    description: "Malnutrition screening by population (under 5, school age, adult, pregnant and postpartum)",
    register: [registerUnder5MalnutritionScreeningTools, registerPregnantPostpartumScreeningTools, registerSchoolAgeScreeningTools, registerAdultScreeningTools],
  },
  paediatric: {
    description: "Paediatric assessment, WHO/INTERGROWTH/Fenton growth charts and BMI-for-age",
    register: [registerPediatricTools, registerPediatricAssessmentTools, registerWhoGrowthTools, registerBmiForAgeTools, registerIntergrowthPretermGrowthTools, registerFentonPretermTools, registerGrowthAssessTools],
  },
  burns: {
    description: "Burn nutrition, adult and paediatric",
    register: [registerBurnNutritionTools, registerPediatricBurnTools],
  },
};

export const TOOLSET_NAMES = Object.keys(TOOLSETS);

/**
 * Parses the ?toolset= query value (comma separated, case-insensitive).
 * Returns null for "no filter" (absent, empty or "all"), otherwise the chosen
 * names, plus any names that don't exist so the caller can reject them.
 */
export function parseToolsets(value: string | null): { selected: string[] | null; unknown: string[] } {
  const names = (value ?? "").split(",").map((n) => n.trim().toLowerCase()).filter(Boolean);
  if (names.length === 0 || names.includes("all")) return { selected: null, unknown: [] };
  const unknown = names.filter((n) => !(n in TOOLSETS));
  return { selected: [...new Set(names.filter((n) => n in TOOLSETS))], unknown };
}
