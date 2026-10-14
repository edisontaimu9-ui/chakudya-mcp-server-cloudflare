import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerClinicalTools } from "../tools/clinicalTools.js";
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
import { registerUnder5MalnutritionScreeningTools } from "../tools/under5MalnutritionScreeningTools.js";
import { registerPregnantPostpartumScreeningTools } from "../tools/pregnantPostpartumScreeningTools.js";
import { registerSchoolAgeScreeningTools } from "../tools/schoolAgeScreeningTools.js";
import { registerAdultScreeningTools } from "../tools/adultScreeningTools.js";
import { registerPediatricAssessmentTools } from "../tools/pediatricAssessmentTools.js";
import { registerIntergrowthPretermGrowthTools } from "../tools/intergrowthPretermGrowthTools.js";

/**
 * Builds a new McpServer instance with every Chakudya tool registered.
 *
 * A fresh instance is created per HTTP request (see src/index.ts). Every tool here is
 * stateless: calculators, reference tables and screening workflows that run inside this
 * Worker. Anything chakudya-api already serves as a REST endpoint (food lookup, recipes
 * and meals, the food log, favorites and history, session memory, the Fenton and WHO
 * growth classifiers, DRI, exchange lists, RAG retrieval and so on) is NOT duplicated
 * here: call chakudya-api directly for those. The two tools that still reach the API
 * (the education tools through /rag/ask, and school_age_integrated_screen through
 * /bmi-for-age/classify) send CHAKUDYA_API_KEY, see clients/chakudyaClient.ts.
 */
export function createChakudyaMcpServer(): McpServer {
  const server = new McpServer({
    name: "chakudya-nutrition-registry",
    version: "1.0.0",
  });

  registerClinicalTools(server);
  registerEducationTools(server);
  registerPediatricTools(server);
  registerEnergyExpenditureTools(server);
  registerWhoGrowthTools(server);
  registerNacsClassificationTools(server);
  registerAspenRefeedingTools(server);
  registerGlimMalnutritionTools(server);
  registerSgaAssessmentTools(server);
  registerBurnNutritionTools(server);
  registerPediatricBurnTools(server);
  registerClinicalNutritionAssessmentTools(server);
  registerAdjustedBodyWeightTools(server);
  registerIndicationEnergyProteinTools(server);
  registerHarrisBenedictStressFactorTools(server);
  registerCriticalCareNutritionSupportTools(server);
  registerStatureEstimationTools(server);
  registerWeightEstimationTools(server);
  registerBodyWeightAdjustmentTools(server);
  registerAnthropometricClassificationTools(server);
  registerDietaryReferenceIntakeTables(server);
  registerClinicalReferenceRangesTools(server);
  registerCarbCountingDoseAdjustmentTools(server);
  registerUnder5MalnutritionScreeningTools(server);
  registerPregnantPostpartumScreeningTools(server);
  registerSchoolAgeScreeningTools(server);
  registerAdultScreeningTools(server);
  registerPediatricAssessmentTools(server);
  registerIntergrowthPretermGrowthTools(server);

  return server;
}
