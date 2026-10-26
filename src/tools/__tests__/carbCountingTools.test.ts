import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { initEnv } from "../../config/env.js";
import { registerCarbCountingDoseAdjustmentTools } from "../carbCountingDoseAdjustmentTools.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;

function collect() {
  const handlers: Record<string, Handler> = {};
  const fake = { registerTool: (name: string, _cfg: unknown, h: Handler) => void (handlers[name] = h) } as unknown as McpServer;
  registerCarbCountingDoseAdjustmentTools(fake);
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

describe("carb counting tools call chakudya-api", () => {
  initEnv({ CHAKUDYA_API_BASE_URL: "https://api.test", ENVIRONMENT: "development" });
  const h = collect();
  const envelope = { status: "success", data: { marker: "from-api", disclaimer: "the disclaimer", citation: "the citation" } };

  it("registers the six tools", () => {
    expect(Object.keys(h).sort()).toEqual([
      "carb_containing_foods_reference", "carbohydrate_content_calculator", "dose_adjustment_stepwise_reference",
      "handy_carb_measures_reference", "insulin_types_reference", "mealtime_insulin_dose_calculator",
    ]);
  });

  it("carbohydrate_content_calculator POSTs the inputs to /carb-counting/carbohydrate-content", async () => {
    const args = { carb_per_100g: 60, portion_weight_g: 150 };
    const { out, seen } = await call(h.carbohydrate_content_calculator, args, envelope);
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("POST");
    expect(seen[0].url.pathname).toBe("/carb-counting/carbohydrate-content");
    expect(seen[0].body).toEqual(args);
    expect(out.isError).toBeUndefined();
    expect(out.content[0].text).toContain("from-api");
  });

  it("mealtime_insulin_dose_calculator POSTs the inputs to /carb-counting/insulin-dose", async () => {
    const args = { total_carb_g: 50, icr_units_per_10g: 1, current_bg_mmol_l: 12, target_bg_low_mmol_l: 6, target_bg_high_mmol_l: 8 };
    const { seen } = await call(h.mealtime_insulin_dose_calculator, args, envelope);
    expect(seen[0].method).toBe("POST");
    expect(seen[0].url.pathname).toBe("/carb-counting/insulin-dose");
    expect(seen[0].body).toEqual(args);
  });

  it("carb_containing_foods_reference GETs /carb-counting/foods, with list when given", async () => {
    const all = await call(h.carb_containing_foods_reference, {}, envelope);
    expect(all.seen[0].method).toBe("GET");
    expect(all.seen[0].url.pathname).toBe("/carb-counting/foods");
    expect(all.seen[0].url.search).toBe("");
    const one = await call(h.carb_containing_foods_reference, { list: "affects_blood_glucose" }, envelope);
    expect(one.seen[0].url.searchParams.get("list")).toBe("affects_blood_glucose");
  });

  it("handy_carb_measures_reference GETs /carb-counting/handy-measures", async () => {
    const { seen, out } = await call(h.handy_carb_measures_reference, {}, envelope);
    expect(seen[0].method).toBe("GET");
    expect(seen[0].url.pathname).toBe("/carb-counting/handy-measures");
    expect(out.content[0].text).toContain("from-api");
  });

  it("insulin_types_reference GETs /carb-counting/insulin-types, with category when given", async () => {
    const all = await call(h.insulin_types_reference, {}, envelope);
    expect(all.seen[0].url.pathname).toBe("/carb-counting/insulin-types");
    expect(all.seen[0].url.search).toBe("");
    const one = await call(h.insulin_types_reference, { category: "quick_acting" }, envelope);
    expect(one.seen[0].url.searchParams.get("category")).toBe("quick_acting");
  });

  it("dose_adjustment_stepwise_reference GETs /carb-counting/dose-adjustment, with section when given", async () => {
    const all = await call(h.dose_adjustment_stepwise_reference, {}, envelope);
    expect(all.seen[0].url.pathname).toBe("/carb-counting/dose-adjustment");
    const one = await call(h.dose_adjustment_stepwise_reference, { section: "stepwise_approach" }, envelope);
    expect(one.seen[0].url.searchParams.get("section")).toBe("stepwise_approach");
  });

  it("keeps the disclaimer and citation beside the data", async () => {
    const { out } = await call(h.mealtime_insulin_dose_calculator, { total_carb_g: 50, icr_units_per_10g: 1 }, envelope);
    const parsed = JSON.parse(out.content[0].text);
    expect(parsed.disclaimer).toBe("the disclaimer");
    expect(parsed.citation).toBe("the citation");
    expect(parsed.data).toEqual({ marker: "from-api" });
  });

  it("surfaces an API validation error as a tool error", async () => {
    const { out } = await call(h.carbohydrate_content_calculator, { carb_per_100g: 20 }, { status: "error", message: "Provide either portion_weight_g or target_carb_g." }, 400);
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain("Provide either portion_weight_g");
  });

  it("surfaces a missing-reference-data 503 as a tool error", async () => {
    const { out } = await call(h.carb_containing_foods_reference, {}, { status: "error", message: "clinical_reference_values has no carb_counting rows. Run sql/042_add_carb_counting_reference_values.sql in Supabase to seed them." }, 503);
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain("042_add_carb_counting_reference_values");
  });
});
