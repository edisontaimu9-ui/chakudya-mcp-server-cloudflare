import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { initEnv } from "../../config/env.js";
import { registerGrowthAssessTools } from "../growthAssessTools.js";
import { registerMeasuresConversionTools } from "../measuresConversionTools.js";
import { registerEnergyEngineTools } from "../energyEngineTools.js";
import { registerFoodLookupTools } from "../foodLookupTools.js";
import { registerFhirNcpTools, flatParamsToFhir, toFhirParameters, FHIR_OPERATIONS } from "../fhirNcpTools.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;

function collect(...registrars: Array<(s: McpServer) => void>) {
  const handlers: Record<string, Handler> = {};
  const fake = { registerTool: (name: string, _cfg: unknown, h: Handler) => void (handlers[name] = h) } as unknown as McpServer;
  registrars.forEach((r) => r(fake));
  return handlers;
}

async function call(handler: Handler, args: Record<string, unknown>, reply: unknown, status = 200) {
  const original = globalThis.fetch;
  const seen: { url: URL; method: string; body: unknown }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: new URL(String(input)), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify(reply), { status });
  }) as typeof fetch;
  try {
    return { out: await handler(args), seen };
  } finally {
    globalThis.fetch = original;
  }
}

describe("API-sync tools", () => {
  initEnv({ CHAKUDYA_API_BASE_URL: "https://api.test", ENVIRONMENT: "development" });
  const h = collect(registerGrowthAssessTools, registerMeasuresConversionTools, registerEnergyEngineTools, registerFoodLookupTools, registerFhirNcpTools);
  const envelope = { status: "success", data: { ok: true } };

  it("registers every new tool", () => {
    for (const n of ["growth_assess", "measures_catalog", "measures_convert", "food_convert", "energy_factors_reference", "energy_requirements",
      "food_energy_calculate", "activity_energy_list", "activity_energy_calculate", "find_food", "foods_by_category", "search_foods_advanced",
      "fhir_ncp_operation", "fhir_questionnaire", "fhir_ncp_diagnosis_codes", "fhir_capability_statement"]) {
      expect(h[n], n).toBeTypeOf("function");
    }
  });

  it("growth_assess calls GET /growth/assess with the measurements and rejects none", async () => {
    const { seen } = await call(h.growth_assess, { sex: "girls", age_months: 18, weight_kg: 9.5, muac_cm: 12.5 }, envelope);
    expect(seen[0].url.pathname).toBe("/growth/assess");
    expect(seen[0].url.searchParams.get("sex")).toBe("girls");
    expect(seen[0].url.searchParams.get("muac_cm")).toBe("12.5");
    const none = await call(h.growth_assess, { sex: "boys", age_months: 18 }, envelope);
    expect(none.out.isError).toBe(true);
    expect(none.seen).toHaveLength(0);
  });

  it("food_convert uses /foods/:id/convert for an id and /foods/convert for a name", async () => {
    const a = await call(h.food_convert, { food_id: 12, amount: 2, unit: "cup" }, envelope);
    expect(a.seen[0].url.pathname).toBe("/foods/12/convert");
    const b = await call(h.food_convert, { food_name: "rice", amount: 300, unit: "g" }, envelope);
    expect(b.seen[0].url.pathname).toBe("/foods/convert");
    expect(b.seen[0].url.searchParams.get("q")).toBe("rice");
  });

  it("measures_convert sends amount/from/to", async () => {
    const { seen } = await call(h.measures_convert, { amount: "1/2", from: "cup", to: "ml" }, envelope);
    expect(seen[0].url.pathname).toBe("/measures/convert");
    expect(seen[0].url.searchParams.get("amount")).toBe("1/2");
  });

  it("energy tools hit the right routes and methods", async () => {
    const r = await call(h.energy_requirements, { sex: "female", age_years: 30, weight_kg: 60, height_cm: 160 }, envelope);
    expect(r.seen[0]).toMatchObject({ method: "POST" });
    expect(r.seen[0].url.pathname).toBe("/energy/requirements");
    const noAge = await call(h.energy_requirements, { sex: "male", weight_kg: 70 }, envelope);
    expect(noAge.out.isError).toBe(true);
    const f = await call(h.food_energy_calculate, { protein_g: 3.4, fat_g: 3.1, carbohydrate_g: 4.6 }, envelope);
    expect(f.seen[0].url.pathname).toBe("/energy/food-energy");
    const act = await call(h.activity_energy_calculate, { weight_kg: 60, activities: [{ activity: "walking", minutes: 30 }] }, envelope);
    expect(act.seen[0].url.pathname).toBe("/activity-energy/calculate");
    const missing = await call(h.activity_energy_calculate, { weight_kg: 60, activities: [{ activity: "walking" }] }, envelope);
    expect(missing.out.isError).toBe(true);
  });

  it("find_food reports ambiguity and alternates from /foods/lookup", async () => {
    const reply = { status: "success", data: { food_name: "Rice" }, source: "local", ambiguous: true, alternates: [{ food_name: "Rice, soaked" }], note: "n" };
    const { out, seen } = await call(h.find_food, { query: "rice", with_servings: true }, reply);
    expect(seen[0].url.pathname).toBe("/foods/lookup");
    expect(seen[0].url.searchParams.get("with_servings")).toBe("true");
    expect(JSON.parse(out.content[0].text).ambiguous).toBe(true);
  });

  it("search_foods_advanced needs at least one filter; foods_by_category passes category", async () => {
    expect((await call(h.search_foods_advanced, {}, envelope)).out.isError).toBe(true);
    const c = await call(h.foods_by_category, { category: "Cereals" }, envelope);
    expect(c.seen[0].url.pathname).toBe("/foods/by-category");
  });
});

describe("FHIR NCP tools", () => {
  initEnv({ CHAKUDYA_API_BASE_URL: "https://api.test", ENVIRONMENT: "development" });
  const h = collect(registerFhirNcpTools);

  it("converts flat parameters to a FHIR Parameters resource", () => {
    const p = flatParamsToFhir({ tool: "must", bmi: 17.2, days: 5, acuteDiseaseNoIntake: false, weight: { value: 52, unit: "kg" }, skip: undefined });
    expect(p.resourceType).toBe("Parameters");
    expect(p.parameter).toEqual([
      { name: "tool", valueString: "must" },
      { name: "bmi", valueDecimal: 17.2 },
      { name: "days", valueInteger: 5 },
      { name: "acuteDiseaseNoIntake", valueBoolean: false },
      { name: "weight", valueQuantity: { value: 52, unit: "kg" } },
    ]);
  });

  it("passes an existing Parameters resource through unchanged and rejects unsupported values", () => {
    const full = { resourceType: "Parameters", parameter: [{ name: "x", valueString: "y" }] };
    expect(toFhirParameters(full)).toBe(full);
    expect(() => flatParamsToFhir({ list: [1, 2] })).toThrow(/unsupported/);
  });

  it("POSTs to the operation path and surfaces OperationOutcome diagnostics on error", async () => {
    const good = await call(h.fhir_ncp_operation, { operation: "screen", parameters: { tool: "must", bmi: 17 } }, { resourceType: "Bundle" });
    expect(good.seen[0].url.pathname).toBe(`/fhir/${FHIR_OPERATIONS.screen}`);
    expect((good.seen[0].body as { resourceType: string }).resourceType).toBe("Parameters");
    const outcome = { resourceType: "OperationOutcome", issue: [{ severity: "error", diagnostics: "Provide 'bmi'" }] };
    const bad = await call(h.fhir_ncp_operation, { operation: "screen", parameters: {} }, outcome, 422);
    expect(bad.out.isError).toBe(true);
    expect(bad.out.content[0].text).toContain("Provide 'bmi'");
  });

  it("fhir_questionnaire lists or fetches by id", async () => {
    expect((await call(h.fhir_questionnaire, {}, { resourceType: "Bundle" })).seen[0].url.pathname).toBe("/fhir/Questionnaire");
    expect((await call(h.fhir_questionnaire, { id: "must" }, { resourceType: "Questionnaire" })).seen[0].url.pathname).toBe("/fhir/Questionnaire/must");
  });
});
