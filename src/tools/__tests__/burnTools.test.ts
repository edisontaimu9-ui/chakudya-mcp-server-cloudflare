import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { initEnv } from "../../config/env.js";
import { registerBurnNutritionTools } from "../burnNutritionTools.js";
import { registerPediatricBurnTools } from "../pediatricBurnTools.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;

function collect() {
  const handlers: Record<string, Handler> = {};
  const fake = { registerTool: (name: string, _cfg: unknown, h: Handler) => void (handlers[name] = h) } as unknown as McpServer;
  registerBurnNutritionTools(fake);
  registerPediatricBurnTools(fake);
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

describe("burn tools call chakudya-api", () => {
  initEnv({ CHAKUDYA_API_BASE_URL: "https://api.test", ENVIRONMENT: "development" });
  const h = collect();
  const envelope = { status: "success", data: { marker: "from-api", disclaimer: "the disclaimer", citation: "the citation" } };

  const POSTS: Array<[string, string, Record<string, unknown>]> = [
    ["burn_fluid_resuscitation_parkland", "/burns/fluid-resuscitation", { weight_kg: 70, tbsa_burned_percent: 40 }],
    ["burn_energy_requirements", "/burns/energy", { weight_kg: 8, height_cm: 70, age_years: 2, sex: "female" }],
    ["burn_protein_requirements", "/burns/protein", { tbsa_burned_percent: 35, weight_kg: 70 }],
    ["burn_nitrogen_balance", "/burns/nitrogen-balance", { protein_intake_g: 100, uun_g: 10 }],
    ["burn_micronutrient_dosing", "/burns/micronutrients", { tbsa_burned_percent: 30 }],
    ["burn_glucose_glycemic_targets", "/burns/glycemic-targets", { weight_kg: 70 }],
    ["burn_pediatric_maintenance_fluid_holliday_segar", "/burns/maintenance-fluid", { weight_kg: 15 }],
    ["burn_indirect_calorimetry_ree", "/burns/indirect-calorimetry", { vo2_ml_per_min: 250, vco2_ml_per_min: 200 }],
    ["burn_pediatric_predictive_equations_comparison", "/burns/pediatric-equations", { sex: "male", age_years: 5, weight_kg: 18 }],
    ["burn_hypermetabolism_pharmacologic_dosing", "/burns/pharmacology", { weight_kg: 20 }],
  ];

  it("registers all ten tools under their original names", () => {
    for (const [name] of POSTS) expect(h[name], name).toBeTypeOf("function");
    expect(Object.keys(h)).toHaveLength(10);
  });

  for (const [tool, path, args] of POSTS) {
    it(`${tool} POSTs the inputs to ${path}`, async () => {
      const { out, seen } = await call(h[tool], args, envelope);
      expect(seen).toHaveLength(1);
      expect(seen[0].method).toBe("POST");
      expect(seen[0].url.pathname).toBe(path);
      expect(seen[0].body).toEqual(args);
      expect(out.isError).toBeUndefined();
      expect(out.content[0].text).toContain("from-api");
    });
  }

  it("keeps the disclaimer and citation beside the data, as these tools always did", async () => {
    const { out } = await call(h.burn_protein_requirements, { tbsa_burned_percent: 35 }, envelope);
    const parsed = JSON.parse(out.content[0].text);
    expect(parsed.disclaimer).toBe("the disclaimer");
    expect(parsed.citation).toBe("the citation");
    expect(parsed.data).toEqual({ marker: "from-api" });
  });

  it("surfaces an API validation error as a tool error", async () => {
    const { out } = await call(h.burn_energy_requirements, { weight_kg: 70, height_cm: 170, age_years: 40, sex: "male" }, { status: "error", message: "Adult (Toronto equation) requires: tbsa_burned_percent." }, 400);
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain("tbsa_burned_percent");
  });

  it("surfaces a missing-reference-data 503 as a tool error", async () => {
    const { out } = await call(h.burn_nitrogen_balance, { protein_intake_g: 100, uun_g: 10 }, { status: "error", message: "clinical_reference_values has no burns rows. Run sql/039_add_clinical_reference_values.sql in Supabase to seed them." }, 503);
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain("039_add_clinical_reference_values");
  });
});
