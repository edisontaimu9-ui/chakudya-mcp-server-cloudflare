import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { initEnv } from "../../config/env.js";
import { registerCriticalCareNutritionSupportTools } from "../criticalCareNutritionSupportTools.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;

function collect() {
  const handlers: Record<string, Handler> = {};
  const fake = { registerTool: (name: string, _cfg: unknown, h: Handler) => void (handlers[name] = h) } as unknown as McpServer;
  registerCriticalCareNutritionSupportTools(fake);
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

describe("critical care tools call chakudya-api", () => {
  initEnv({ CHAKUDYA_API_BASE_URL: "https://api.test", ENVIRONMENT: "development" });
  const h = collect();
  const envelope = { status: "success", data: { marker: "from-api" } };

  const POSTS: Array<[string, string, Record<string, unknown>]> = [
    ["protein_requirement_by_stress_level", "/critical-care/protein-by-stress", { stress_level: 2, weight_kg: 70 }],
    ["npe_nitrogen_ratio_calculator", "/critical-care/npe-nitrogen-ratio", { npe_kcal: 1500, protein_g: 75 }],
    ["nitrogen_balance_calculator", "/critical-care/nitrogen-balance", { urine_volume_l: 2, urinary_urea_mmol_l: 250 }],
    ["carbohydrate_requirement_reference", "/critical-care/carbohydrate", { weight_kg: 70 }],
    ["propofol_fat_content_calculator", "/critical-care/propofol-fat", { propofol_percent: "1", volume_ml: 100 }],
    ["electrolyte_replacement_reference", "/critical-care/electrolytes", { electrolyte: "potassium" }],
    ["potassium_deficit_estimator", "/critical-care/potassium-deficit", { serum_k_mmol_l: 2.6 }],
    ["icu_fluid_requirement_calculator", "/critical-care/fluid", { weight_kg: 70 }],
  ];
  const GETS: Array<[string, string]> = [
    ["fat_requirement_reference", "/critical-care/fat"],
    ["cho_fat_ratio_reference", "/critical-care/cho-fat-ratio"],
  ];

  it("registers all ten tools under their original names", () => {
    for (const n of [...POSTS.map((p) => p[0]), ...GETS.map((g) => g[0])]) expect(h[n], n).toBeTypeOf("function");
    expect(Object.keys(h)).toHaveLength(10);
  });

  for (const [tool, path, args] of POSTS) {
    it(`${tool} POSTs the inputs to ${path} and returns the API data`, async () => {
      const { out, seen } = await call(h[tool], args, envelope);
      expect(seen).toHaveLength(1);
      expect(seen[0].method).toBe("POST");
      expect(seen[0].url.pathname).toBe(path);
      expect(seen[0].body).toEqual(args);
      expect(out.isError).toBeUndefined();
      expect(out.content[0].text).toContain("from-api");
    });
  }

  for (const [tool, path] of GETS) {
    it(`${tool} GETs ${path}`, async () => {
      const { out, seen } = await call(h[tool], {}, envelope);
      expect(seen[0].method).toBe("GET");
      expect(seen[0].url.pathname).toBe(path);
      expect(out.content[0].text).toContain("from-api");
    });
  }

  it("surfaces an API validation error as a tool error", async () => {
    const { out } = await call(h.icu_fluid_requirement_calculator, { weight_kg: 70 }, { status: "error", message: "'weight_kg' must be greater than 0" }, 400);
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain("weight_kg");
  });
});
