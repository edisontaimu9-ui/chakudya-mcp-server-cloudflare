import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { initEnv } from "../../config/env.js";
import { registerAspenRefeedingTools } from "../aspenRefeedingTools.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;

function collect() {
  const handlers: Record<string, Handler> = {};
  const fake = { registerTool: (name: string, _cfg: unknown, h: Handler) => void (handlers[name] = h) } as unknown as McpServer;
  registerAspenRefeedingTools(fake);
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

describe("ASPEN refeeding tools call chakudya-api", () => {
  initEnv({ CHAKUDYA_API_BASE_URL: "https://api.test", ENVIRONMENT: "development" });
  const h = collect();
  const envelope = { status: "success", data: { marker: "from-api", disclaimer: "the disclaimer", citation: "the citation" } };

  const POSTS: Array<[string, string, Record<string, unknown>]> = [
    ["aspen_refeeding_risk_adult", "/refeeding/risk-adult", { bmi: 15, caloric_intake_level: "moderate" }],
    ["aspen_refeeding_risk_pediatric", "/refeeding/risk-pediatric", { low_intake_days: 6, muac_z_score: -2.4 }],
    ["aspen_refeeding_syndrome_severity", "/refeeding/severity", { potassium_baseline: 4, potassium_current: 3, within_5_days_of_refeeding: true }],
    ["aspen_refeeding_initiation_guidance", "/refeeding/initiation", { population: "adult", weight_kg: 60 }],
  ];

  it("registers the four tools under their original names", () => {
    for (const [name] of POSTS) expect(h[name], name).toBeTypeOf("function");
    expect(Object.keys(h)).toHaveLength(4);
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

  it("keeps the disclaimer and citation beside the data", async () => {
    const { out } = await call(h.aspen_refeeding_risk_adult, { bmi: 15 }, envelope);
    const parsed = JSON.parse(out.content[0].text);
    expect(parsed.disclaimer).toBe("the disclaimer");
    expect(parsed.citation).toBe("the citation");
    expect(parsed.data).toEqual({ marker: "from-api" });
  });

  it("surfaces an API validation error as a tool error", async () => {
    const { out } = await call(h.aspen_refeeding_risk_adult, {}, { status: "error", message: "Provide at least one criterion." }, 400);
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain("at least one criterion");
  });

  it("surfaces a missing-reference-data 503 as a tool error", async () => {
    const { out } = await call(h.aspen_refeeding_syndrome_severity, { potassium_percent_decrease: 15 }, { status: "error", message: "clinical_reference_values has no refeeding rows. Run sql/040_add_refeeding_reference_values.sql in Supabase to seed them." }, 503);
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain("040_add_refeeding_reference_values");
  });
});
