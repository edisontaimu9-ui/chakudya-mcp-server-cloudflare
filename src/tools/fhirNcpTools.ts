import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ChakudyaApiError, chakudyaClient } from "../clients/chakudyaClient.js";
import { ok, safeTool, toolError } from "../utils/toolResult.js";

/**
 * chakudya-api's FHIR R4 facade: the Nutrition Care Process (screening, assessment, diagnosis,
 * intervention, monitoring, goals, ADIME document), the nutrition-assessment bundle, care context and
 * questionnaire validation. Every operation is stateless on the API side (nothing is stored).
 *
 * Operations take a FHIR Parameters resource. To keep calls simple, `parameters` may also be a flat
 * object ({ tool: "must", bmi: 17.2, acuteDiseaseNoIntake: false, weight: {value: 52, unit: "kg"} }),
 * which flatParamsToFhir() converts: numbers -> valueDecimal/valueInteger, booleans -> valueBoolean,
 * strings -> valueString, { value, unit } objects -> valueQuantity.
 */
export const FHIR_OPERATIONS = {
  screen: "Observation/$screen",
  assess_nutrition: "Observation/$assess-nutrition",
  diagnose: "Condition/$diagnose",
  intervene: "CarePlan/$intervene",
  monitor: "CarePlan/$monitor",
  evaluate_goals: "Goal/$evaluate",
  ncp_document: "Bundle/$ncp-document",
  validate_document: "Bundle/$validate-document",
  care_context: "Bundle/$care-context",
  nutrition_assessment: "Bundle/$nutrition-assessment",
  validate_questionnaire_response: "QuestionnaireResponse/$validate",
  translate_concept: "ConceptMap/$translate",
} as const;
export type FhirOperationKey = keyof typeof FHIR_OPERATIONS;

type FhirParameter = Record<string, unknown> & { name: string };

export function flatParamsToFhir(flat: Record<string, unknown>): { resourceType: "Parameters"; parameter: FhirParameter[] } {
  const parameter: FhirParameter[] = [];
  for (const [name, v] of Object.entries(flat)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "boolean") parameter.push({ name, valueBoolean: v });
    else if (typeof v === "number") parameter.push({ name, ...(Number.isInteger(v) ? { valueInteger: v } : { valueDecimal: v }) });
    else if (typeof v === "string") parameter.push({ name, valueString: v });
    else if (typeof v === "object" && !Array.isArray(v) && "value" in (v as object)) parameter.push({ name, valueQuantity: v });
    else throw new Error(`Parameter '${name}' has an unsupported type; pass a full FHIR Parameters resource instead.`);
  }
  return { resourceType: "Parameters", parameter };
}

export function toFhirParameters(input: Record<string, unknown>) {
  return input.resourceType === "Parameters" ? input : flatParamsToFhir(input);
}

/** FHIR errors come back as an OperationOutcome; surface its diagnostics instead of "HTTP 422". */
export function describeFhirError(e: ChakudyaApiError): string {
  const issues = (e.body as { issue?: Array<{ diagnostics?: string; details?: { text?: string } }> } | null)?.issue;
  const text = Array.isArray(issues) ? issues.map((i) => i.diagnostics ?? i.details?.text).filter(Boolean).join("; ") : "";
  return `Chakudya FHIR error (${e.status}): ${text || e.message}`;
}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

export function registerFhirNcpTools(server: McpServer) {
  server.registerTool(
    "fhir_ncp_operation",
    {
      title: "Nutrition Care Process via FHIR (screen, assess, diagnose, intervene, monitor, document)",
      description:
        "Run one operation of Chakudya's FHIR R4 Nutrition Care Process facade. operation: screen (tool = must | nrs-2002 | mna | sga | pg-sga | nacs), " +
        "assess_nutrition, diagnose (NI/NC/NB codes), intervene, monitor, evaluate_goals, ncp_document (ADIME document), validate_document, care_context, " +
        "nutrition_assessment, validate_questionnaire_response, translate_concept. 'parameters' is a FHIR Parameters resource, or a flat object " +
        "such as {tool:'must', bmi:17.2, weightLossPercent3to6Months:6, acuteDiseaseNoIntake:false}; use {value, unit} for quantities " +
        "(e.g. weight:{value:52,unit:'kg'}). Use fhir_questionnaire to get the question lists for a screening tool. Required parameters differ per " +
        "operation and tool; the API's error message names whatever is missing. Screening aid only; stateless, nothing is stored.",
      inputSchema: {
        operation: z.enum(Object.keys(FHIR_OPERATIONS) as [FhirOperationKey, ...FhirOperationKey[]]),
        parameters: z.record(z.unknown()),
      },
      annotations: READ,
    },
    async ({ operation, parameters }) => {
      try {
        const body = toFhirParameters(parameters);
        const res = await chakudyaClient.post(`/fhir/${FHIR_OPERATIONS[operation]}`, body);
        return ok(res.data ?? res, { disclaimer: "Screening/decision aid only; confirm with clinical judgement." });
      } catch (e) {
        if (e instanceof ChakudyaApiError) return toolError(describeFhirError(e));
        return toolError(`Invalid parameters: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );

  server.registerTool(
    "fhir_questionnaire",
    {
      title: "FHIR Questionnaires (screening tool question lists)",
      description:
        "Fetch the FHIR Questionnaire for a Chakudya screening or assessment tool, so you know which questions to ask before calling fhir_ncp_operation. " +
        "Omit id to list the available questionnaires.",
      inputSchema: { id: z.string().min(1).optional().describe("Questionnaire id, e.g. 'must' or 'nrs-2002'") },
      annotations: READ,
    },
    safeTool("fhir_questionnaire", async ({ id }) => {
      const res = await chakudyaClient.get(id ? `/fhir/Questionnaire/${encodeURIComponent(id)}` : "/fhir/Questionnaire");
      return ok(res.data ?? res);
    })
  );

  server.registerTool(
    "fhir_ncp_diagnosis_codes",
    {
      title: "NCP Nutrition Diagnosis Terminology (NI / NC / NB)",
      description: "The Nutrition Care Process diagnosis terminology (2006 edition: intake NI-, clinical NC-, behavioural-environmental NB- codes) as a FHIR CodeSystem.",
      inputSchema: {},
      annotations: READ,
    },
    safeTool("fhir_ncp_diagnosis_codes", async () => {
      const res = await chakudyaClient.get("/fhir/CodeSystem/ncp-diagnosis");
      return ok(res.data ?? res);
    })
  );

  server.registerTool(
    "fhir_capability_statement",
    {
      title: "Chakudya FHIR Capability Statement",
      description: "The FHIR CapabilityStatement listing every FHIR operation and resource Chakudya supports.",
      inputSchema: {},
      annotations: READ,
    },
    safeTool("fhir_capability_statement", async () => {
      const res = await chakudyaClient.get("/fhir/metadata");
      return ok(res.data ?? res);
    })
  );
}
