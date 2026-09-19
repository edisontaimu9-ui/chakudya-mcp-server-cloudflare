import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, safeTool } from "../utils/toolResult.js";
import { classifyPregnantPostpartum, NACS_DISCLAIMER, type NacsPregnantPostpartumResult } from "./nacsClassificationTools.js";

/**
 * Pregnant/postpartum malnutrition screening — orchestration layer over
 * classifyPregnantPostpartum() (reused, not duplicated; see
 * nacsClassificationTools.ts). Mirrors under5MalnutritionScreeningTools.ts's
 * architecture and the same three-layer split:
 *   Layer 1 (nacsClassificationTools.ts): deterministic edema/MUAC/weight-
 *     loss classification.
 *   Layer 2 (this file): exposes a referral/action ladder over that
 *     classification as a structured MCP tool result.
 *   Layer 3 (NOT in this file): a conversational agent (e.g.
 *     pregnantPostpartumScreening.js in thanzi-coach-whatsapp) that asks
 *     the health worker questions, calls this tool, and narrates the
 *     result — never recomputing or overriding it.
 *
 * MALAWI / DEPLOYMENT NOTE: same caveat as the under-5 module — the
 * referral wording below is generic/CMAM-aligned, NOT the specific Malawi
 * Ministry of Health protocol. No Malawi-specific facility names, follow-
 * up intervals, or commodity guidance are invented here; see the
 * TODO(malawi-protocol) field in the tool's output.
 */

const MODULE_DISCLAIMER =
  "Screening/decision-support tool only. Classification is produced by deterministic NACS rules " +
  "(edema/MUAC/confirmed weight loss). This is not a diagnosis and not a substitute for assessment " +
  "and management by a qualified health worker. Referral wording is generic/CMAM-aligned, not the " +
  "specific Malawi Ministry of Health protocol — see the todo_malawi_protocol field.";

export interface PregnantPostpartumIntegratedScreenInput {
  edema?: boolean;
  muac_mm?: number;
  moderate_muac_upper_mm?: 220 | 230;
  confirmed_weight_loss_over_10_percent?: boolean;
}

export interface PregnantPostpartumIntegratedScreenResult {
  status: "success";
  classification: NacsPregnantPostpartumResult;
  clinical_flags: Array<{ flag: string; detail: string }>;
  recommended_action: { urgency: "urgent" | "priority" | "routine"; action: string };
  referral: { pathway: string; todo_malawi_protocol: string };
  explanation: string;
  limitations: string[];
}

/**
 * Integrated pregnant/postpartum screening. Calls classifyPregnantPostpartum()
 * (reused, not duplicated) and adds a deterministic referral/action ladder —
 * the one piece of logic that tool doesn't already provide.
 */
export function integratedPregnantPostpartumScreen(
  input: PregnantPostpartumIntegratedScreenInput
): { ok: true; result: PregnantPostpartumIntegratedScreenResult } | { ok: false; error: string } {
  let classification: NacsPregnantPostpartumResult;
  try {
    classification = classifyPregnantPostpartum(input);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  const flags: Array<{ flag: string; detail: string }> = [];
  for (const ind of classification.indicators) {
    if (ind.classification !== "normal") {
      flags.push({
        flag: `nacs_${ind.indicator}:${ind.classification}`,
        detail: `${ind.indicator} = ${ind.value} -> ${ind.classification} (${ind.cutoffApplied}).`,
      });
    }
  }
  if (input.edema === undefined) flags.push({ flag: "missing_measurement:edema", detail: "edema was not provided — not invented or substituted." });
  if (input.muac_mm === undefined) flags.push({ flag: "missing_measurement:muac_mm", detail: "muac_mm was not provided — not invented or substituted." });
  if (input.confirmed_weight_loss_over_10_percent === undefined) {
    flags.push({
      flag: "missing_measurement:confirmed_weight_loss_over_10_percent",
      detail: "confirmed_weight_loss_over_10_percent was not provided — not invented or substituted.",
    });
  }

  // TODO(malawi-protocol): replace this generic, CMAM-aligned ladder with the
  // current Malawi Ministry of Health CMAM/NACS referral protocol for
  // pregnant/postpartum women (specific facility types, follow-up
  // intervals, commodity guidance) before real-world deployment.
  let urgency: PregnantPostpartumIntegratedScreenResult["recommended_action"]["urgency"];
  let action: string;
  if (classification.overallMalnutritionClassification === "severe") {
    urgency = "urgent";
    action =
      "Urgent referral to a qualified health worker for assessment and management of suspected severe " +
      "acute malnutrition in this pregnant/postpartum woman, per national CMAM protocol — same day if possible.";
  } else if (classification.overallMalnutritionClassification === "moderate") {
    urgency = "priority";
    action = "Refer for supplementary feeding / nutrition counselling for suspected moderate acute malnutrition.";
  } else {
    urgency = "routine";
    action = "No acute malnutrition identified on this screening — continue routine antenatal/postnatal nutrition counselling.";
  }

  const explanationParts: string[] = [];
  for (const ind of classification.indicators) {
    explanationParts.push(`${ind.indicator} = ${ind.value} -> ${ind.classification} (${ind.cutoffApplied}).`);
  }
  explanationParts.push(`Overall NACS classification: ${classification.overallMalnutritionClassification}.`);
  explanationParts.push(`Recommended action (${urgency}): ${action}`);

  return {
    ok: true,
    result: {
      status: "success",
      classification,
      clinical_flags: flags,
      recommended_action: { urgency, action },
      referral: {
        pathway: action,
        todo_malawi_protocol:
          "TODO: replace with the current Malawi Ministry of Health CMAM/NACS referral protocol for " +
          "pregnant/postpartum women. Not present in this repository, so not invented here.",
      },
      explanation: explanationParts.join(" "),
      limitations: [
        "This is a screening/decision-support prototype, not a diagnostic device. All findings should be " +
          "confirmed and acted on by a qualified health worker.",
        "WHO has not established a single standard MUAC cutoff for this population; confirm which " +
          "moderate_muac_upper_mm (220 or 230mm) your program uses.",
        "Referral pathway wording is generic/CMAM-aligned; it must be replaced with the current Malawi " +
          "Ministry of Health CMAM/NACS protocol before real-world deployment.",
      ],
    },
  };
}

export function registerPregnantPostpartumScreeningTools(server: McpServer): void {
  server.registerTool(
    "pregnant_postpartum_integrated_screen",
    {
      title: "Pregnant/Postpartum Integrated Malnutrition Screening",
      description:
        "Orchestration tool for pregnant/postpartum malnutrition screening. Internally reuses " +
        "classifyPregnantPostpartum's logic (nacs_classify_pregnant_postpartum) and adds a deterministic " +
        "recommended action/referral, clinical flags, an evidence-traceable explanation, and limitations. " +
        "The AI layer calling this tool MUST treat its output as authoritative and MUST NOT recompute, " +
        "override, or soften any classification, and MUST NOT invent measurements the caller did not supply.",
      inputSchema: {
        edema: z.boolean().optional().describe("Any bilateral pitting edema present"),
        muac_mm: z.number().positive().optional().describe("Mid-upper arm circumference in mm"),
        moderate_muac_upper_mm: z
          .union([z.literal(220), z.literal(230)])
          .optional()
          .describe("Country-specific MAM/normal MUAC boundary: 220 (default) or 230mm"),
        confirmed_weight_loss_over_10_percent: z
          .boolean()
          .optional()
          .describe("Confirmed unintentional weight loss >10% since last visit"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("pregnant_postpartum_integrated_screen", async (args) => {
      const outcome = integratedPregnantPostpartumScreen(args);
      if (!outcome.ok) {
        return { content: [{ type: "text" as const, text: outcome.error }], isError: true as const };
      }
      return ok(outcome.result, { disclaimer: MODULE_DISCLAIMER, nacs_disclaimer: NACS_DISCLAIMER });
    })
  );
}
