import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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

/**
 * Builds a new McpServer instance with every Chakudya tool registered.
 *
 * A fresh instance is created per HTTP request (see src/index.ts) — nearly
 * every tool here is stateless (it just calls the Chakudya API and returns),
 * so rebuilding is cheap. The exception is memory: `sessionId` is this
 * request's MCP session identity (the `Mcp-Session-Id` header — see
 * index.ts for where it's minted/read), threaded into registerMemoryTools()
 * so memory_write/memory_recall/memory_consolidate can default to it
 * without the caller having to pass session_id on every call. The
 * server instance itself still holds no state between requests — the actual
 * memory lives in chakudya-api/Supabase, keyed by that session id.
 */
export function createChakudyaMcpServer(sessionId?: string): McpServer {
  const server = new McpServer({
    name: "chakudya-nutrition-registry",
    version: "1.0.0",
  });

  registerFoodTools(server);
  registerClinicalTools(server);
  registerRagTools(server);
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
  registerUserDataTools(server);
  registerMemoryTools(server, sessionId);
  registerPackagedSubmissionTools(server);
  registerRecipeMealTools(server);
  registerFoodLogTools(server);
  registerDriApiTools(server);
  registerFoodComparisonTools(server);
  registerDrugInteractionGlycaemicTools(server);
  registerUnder5MalnutritionScreeningTools(server);
  registerPregnantPostpartumScreeningTools(server);
  registerBmiForAgeTools(server);
  registerSchoolAgeScreeningTools(server);
  registerAdultScreeningTools(server);
  registerPediatricAssessmentTools(server);
  registerIntergrowthPretermGrowthTools(server);
  registerFentonPretermTools(server);

  return server;
}
