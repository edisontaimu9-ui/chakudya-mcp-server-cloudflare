import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { initEnv } from "../../config/env.js";
import { registerHarrisBenedictStressFactorTools } from "../harrisBenedictStressFactorTools.js";
import { registerEnergyExpenditureTools } from "../energyExpenditureTools.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;

function collect() {
  const handlers: Record<string, Handler> = {};
  const fake = { registerTool: (name: string, _cfg: unknown, h: Handler) => void (handlers[name] = h) } as unknown as McpServer;
  registerHarrisBenedictStressFactorTools(fake);
  registerEnergyExpenditureTools(fake);
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

describe("energy and stress factor tools call chakudya-api", () => {
  initEnv({ CHAKUDYA_API_BASE_URL: "https://api.test", ENVIRONMENT: "development" });
  const h = collect();
  const envelope = { status: "success", data: { marker: "from-api", disclaimer: "the disclaimer", citation: "the citation" } };

  it("harris_benedict_bee_calculator POSTs the inputs to /stress-factors/harris-benedict", async () => {
    const args = { sex: "male", weight_kg: 70, height_cm: 175, age_years: 40, stress_factor: 1.2 };
    const { out, seen } = await call(h.harris_benedict_bee_calculator, args, envelope);
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("POST");
    expect(seen[0].url.pathname).toBe("/stress-factors/harris-benedict");
    expect(seen[0].body).toEqual(args);
    expect(out.isError).toBeUndefined();
    expect(out.content[0].text).toContain("from-api");
  });

  it("fever_stress_ree_adjustment POSTs the inputs to /stress-factors/fever", async () => {
    const args = { ree_kcal_per_day: 1500, body_temp_c: 39 };
    const { seen } = await call(h.fever_stress_ree_adjustment, args, envelope);
    expect(seen[0].method).toBe("POST");
    expect(seen[0].url.pathname).toBe("/stress-factors/fever");
    expect(seen[0].body).toEqual(args);
  });

  it("stress_factor_reference GETs the table, with condition_key when given", async () => {
    const all = await call(h.stress_factor_reference, {}, envelope);
    expect(all.seen[0].method).toBe("GET");
    expect(all.seen[0].url.pathname).toBe("/stress-factors/conditions");
    expect(all.seen[0].url.search).toBe("");
    const one = await call(h.stress_factor_reference, { condition_key: "wound_healing" }, envelope);
    expect(one.seen[0].url.searchParams.get("condition_key")).toBe("wound_healing");
  });

  it("twenty_four_hour_energy_adjustment_reference GETs /stress-factors/adjustments", async () => {
    const { seen, out } = await call(h.twenty_four_hour_energy_adjustment_reference, {}, envelope);
    expect(seen[0].method).toBe("GET");
    expect(seen[0].url.pathname).toBe("/stress-factors/adjustments");
    expect(out.content[0].text).toContain("from-api");
  });

  it("keeps the disclaimer and citation beside the data", async () => {
    const { out } = await call(h.harris_benedict_bee_calculator, { sex: "female", weight_kg: 60, height_cm: 160, age_years: 30 }, envelope);
    const parsed = JSON.parse(out.content[0].text);
    expect(parsed.disclaimer).toBe("the disclaimer");
    expect(parsed.citation).toBe("the citation");
    expect(parsed.data).toEqual({ marker: "from-api" });
  });

  it("surfaces an API validation error as a tool error", async () => {
    const { out } = await call(h.stress_factor_reference, { condition_key: "nope" }, { status: "error", message: "Unknown condition_key 'nope'." }, 400);
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain("Unknown condition_key");
  });

  it("surfaces a missing-reference-data 503 as a tool error", async () => {
    const { out } = await call(h.harris_benedict_bee_calculator, { sex: "male", weight_kg: 70, height_cm: 175, age_years: 40 }, { status: "error", message: "clinical_reference_values has no stress_factors rows. Run sql/041_add_stress_factor_reference_values.sql in Supabase to seed them." }, 503);
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain("041_add_stress_factor_reference_values");
  });
});
