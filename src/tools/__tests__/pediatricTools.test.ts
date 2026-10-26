import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { initEnv } from "../../config/env.js";
import { registerPediatricTools } from "../pediatricTools.js";
import { registerPediatricAssessmentTools, computeTeeFromFactors } from "../pediatricAssessmentTools.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;

function collect() {
  const handlers: Record<string, Handler> = {};
  const fake = { registerTool: (name: string, _cfg: unknown, h: Handler) => void (handlers[name] = h) } as unknown as McpServer;
  registerPediatricTools(fake);
  registerPediatricAssessmentTools(fake);
  return handlers;
}

type Seen = { url: URL; method: string; body: any };

/** Replies to every request with the same envelope, or with a function of the request. */
async function call(handler: Handler, args: Record<string, unknown>, reply: unknown | ((s: Seen) => unknown), status = 200) {
  const original = globalThis.fetch;
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const s = { url: new URL(String(input)), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
    seen.push(s);
    return new Response(JSON.stringify(typeof reply === "function" ? (reply as (s: Seen) => unknown)(s) : reply), { status });
  }) as typeof fetch;
  try {
    return { out: await handler(args), seen };
  } finally {
    globalThis.fetch = original;
  }
}

describe("paediatric tools call chakudya-api", () => {
  initEnv({ CHAKUDYA_API_BASE_URL: "https://api.test", ENVIRONMENT: "development" });
  const h = collect();
  const envelope = { status: "success", data: { marker: "from-api", disclaimer: "the disclaimer", citation: "the citation" } };

  const TEN = [
    "pediatric_fluid_requirements",
    "pediatric_energy_requirements",
    "pediatric_protein_requirements",
    "pediatric_growth_velocity",
    "pediatric_enteral_feed_advancement",
    "preterm_fluid_energy_requirements",
    "macronutrient_distribution_check",
    "pediatric_activity_stress_factor_reference",
    "pediatric_growth_velocity_assessment",
    "pediatric_enteral_feed_plan",
  ];

  it("registers all ten tools under their original names", () => {
    for (const n of TEN) expect(h[n], n).toBeTypeOf("function");
  });

  it("fluid posts the weight", async () => {
    const { seen, out } = await call(h.pediatric_fluid_requirements, { weight_kg: 12 }, envelope);
    expect(seen[0].method).toBe("POST");
    expect(seen[0].url.pathname).toBe("/paediatric/fluid");
    expect(seen[0].body).toEqual({ weight_kg: 12 });
    expect(out.content[0].text).toContain("from-api");
    expect(out.content[0].text).toContain("the disclaimer");
  });

  it("energy posts to /paediatric/energy, maps physical_activity_level to pal_category and drops method", async () => {
    const { seen } = await call(
      h.pediatric_energy_requirements,
      { method: "dri_iom_2006", sex: "female", weight_kg: 25, height_cm: 120, age_years: 7, physical_activity_level: "active", stress_factor: 1.2 },
      envelope
    );
    expect(seen[0].url.pathname).toBe("/paediatric/energy");
    expect(seen[0].body).toMatchObject({ sex: "female", weight_kg: 25, height_cm: 120, age_years: 7, pal_category: "active", stress_factor: 1.2 });
    expect(seen[0].body.method).toBeUndefined();
    expect(seen[0].body.physical_activity_level).toBeUndefined();
  });

  it("protein: iom_2005 is healthy, aspen_sick is sick, preterm goes to /paediatric/preterm in grams", async () => {
    const a = await call(h.pediatric_protein_requirements, { source: "iom_2005", weight_kg: 10, age_months: 18 }, envelope);
    expect(a.seen[0].url.pathname).toBe("/paediatric/protein");
    expect(a.seen[0].body).toMatchObject({ weight_kg: 10, age_months: 18, clinical_status: "healthy" });
    const b = await call(h.pediatric_protein_requirements, { source: "aspen_sick", weight_kg: 10, age_years: 3 }, envelope);
    expect(b.seen[0].body.clinical_status).toBe("sick");
    const c = await call(h.pediatric_protein_requirements, { source: "preterm", weight_kg: 1.2 }, envelope);
    expect(c.seen[0].url.pathname).toBe("/paediatric/preterm");
    expect(c.seen[0].body).toEqual({ weight_g: 1200 });
    const d = await call(h.pediatric_protein_requirements, { source: "iom_2005", weight_kg: 10 }, envelope);
    expect(d.out.isError).toBe(true);
    expect(d.seen).toHaveLength(0);
  });

  it("growth velocity reads the matching reference section", async () => {
    const reply = (s: Seen) => ({ status: "success", data: { section: s.url.searchParams.get("section"), [s.url.searchParams.get("section")!]: { rows: 3 } } });
    const term = await call(h.pediatric_growth_velocity, { sex: "female", age_months: 8 }, reply);
    expect(term.seen[0].method).toBe("GET");
    expect(term.seen[0].url.pathname).toBe("/paediatric/reference");
    expect(term.seen[0].url.searchParams.get("section")).toBe("growth_velocity");
    expect(term.out.content[0].text).toContain('"age_months": 8');
    const pre = await call(h.pediatric_growth_velocity, { preterm: true }, reply);
    expect(pre.seen[0].url.searchParams.get("section")).toBe("preterm");
  });

  it("enteral advancement: age only reads the table, with weight it computes volumes", async () => {
    const table = await call(h.pediatric_enteral_feed_advancement, { age_years: 3 }, { status: "success", data: { section: "enteral_feeds", enteral_feeds: { groups: [] } } });
    expect(table.seen[0].url.searchParams.get("section")).toBe("enteral_feeds");
    const vol = await call(h.pediatric_enteral_feed_advancement, { age_years: 3, weight_kg: 14, feed_type: "bolus" }, envelope);
    expect(vol.seen[0].method).toBe("POST");
    expect(vol.seen[0].url.pathname).toBe("/paediatric/enteral-feeds");
    expect(vol.seen[0].body).toMatchObject({ age_years: 3, weight_kg: 14, route: "bolus" });
  });

  it("preterm converts kg to grams", async () => {
    const { seen } = await call(h.preterm_fluid_energy_requirements, { weight_kg: 1.8 }, envelope);
    expect(seen[0].url.pathname).toBe("/paediatric/preterm");
    expect(seen[0].body).toEqual({ weight_g: 1800 });
  });

  describe("macronutrient_distribution_check", () => {
    const ranges = {
      status: "success",
      data: {
        section: "macronutrient_distribution",
        macronutrient_distribution: {
          source: "IOM AMDR",
          ranges: [
            { age: "Full-term infant (0-12 months)", carbohydrate: [35, 65], fat: [30, 55], protein: [7, 16] },
            { age: "1-3 years", carbohydrate: [45, 65], fat: [30, 40], protein: [5, 20] },
            { age: "4-18 years", carbohydrate: [45, 65], fat: [25, 35], protein: [10, 30] },
          ],
        },
      },
    };

    it("picks the row by age and checks the proposal against it", async () => {
      const { out, seen } = await call(h.macronutrient_distribution_check, { age_years: 2, proposed_fat_percent: 45, proposed_carb_percent: 50 }, ranges);
      expect(seen[0].url.searchParams.get("section")).toBe("macronutrient_distribution");
      const text = out.content[0].text;
      expect(text).toContain("1-3 years");
      expect(text).toContain('"fat_in_range": false');
      expect(text).toContain('"carbohydrate_in_range": true');
      expect(text).toContain('"protein_in_range": null');
    });

    it("uses the same band edges as the API (12 and 48 months)", async () => {
      const a = await call(h.macronutrient_distribution_check, { age_months: 11 }, ranges);
      expect(a.out.content[0].text).toContain("Full-term infant");
      const b = await call(h.macronutrient_distribution_check, { age_months: 12 }, ranges);
      expect(b.out.content[0].text).toContain("1-3 years");
      const c = await call(h.macronutrient_distribution_check, { age_months: 48 }, ranges);
      expect(c.out.content[0].text).toContain("4-18 years");
    });

    it("needs an age and makes no request without one", async () => {
      const { out, seen } = await call(h.macronutrient_distribution_check, {}, ranges);
      expect(out.isError).toBe(true);
      expect(seen).toHaveLength(0);
    });
  });

  describe("pediatric_activity_stress_factor_reference", () => {
    const factors = (s: Seen) => {
      const section = s.url.searchParams.get("section")!;
      const data =
        section === "activity_factors"
          ? { light: { label: "Light activity", min: 1.3, max: 1.5, definition: "d" }, vigorous: { label: "High or vigorous activity", min: 1.8, max: 2.15, definition: "v" } }
          : { surgery: { label: "Surgery", min: 1.05, max: 1.5 } };
      return { status: "success", data: { section, [section]: data } };
    };

    it("with no inputs returns both tables from the API", async () => {
      const { out, seen } = await call(h.pediatric_activity_stress_factor_reference, {}, factors);
      expect(seen.map((s) => s.url.searchParams.get("section")).sort()).toEqual(["activity_factors", "stress_factors"]);
      expect(out.content[0].text).toContain("Surgery");
    });

    it("maps high_or_vigorous to the API's vigorous and multiplies the factors", async () => {
      const { out } = await call(
        h.pediatric_activity_stress_factor_reference,
        { bmr_kcal_per_day: 1000, activity_level: "high_or_vigorous", metabolic_condition: "surgery", weight_kg: 20 },
        factors
      );
      const parsed = JSON.parse(out.content[0].text);
      expect(parsed.tee_kcal_per_day.low).toBe(Math.round(1000 * 1.8 * 1.05));
      expect(parsed.tee_kcal_per_day.high).toBe(Math.round(1000 * 2.15 * 1.5));
      expect(parsed.tee_kcal_per_kg_per_day.low).toBeCloseTo((1000 * 1.8 * 1.05) / 20, 1);
    });

    it("rejects a BMR with no factor", async () => {
      const { out } = await call(h.pediatric_activity_stress_factor_reference, { bmr_kcal_per_day: 1000 }, factors);
      expect(out.isError).toBe(true);
    });

    it("computeTeeFromFactors uses 1 for a missing factor", () => {
      const r = computeTeeFromFactors({ bmr_kcal_per_day: 800, stress: { label: "x", min: 1.2, max: 1.6 } });
      expect(r.tee_kcal_per_day).toEqual({ low: 960, mid: 1120, high: 1280 });
      expect(r.activity_factor_range).toBeNull();
    });
  });

  describe("pediatric_growth_velocity_assessment", () => {
    it("term posts the interval to /paediatric/growth-velocity", async () => {
      const { seen } = await call(
        h.pediatric_growth_velocity_assessment,
        { population: "term", sex: "male", age_months: 4, interval_days: 30, weight_start_kg: 6, weight_end_kg: 6.6, length_start_cm: 62, length_end_cm: 64 },
        envelope
      );
      expect(seen[0].url.pathname).toBe("/paediatric/growth-velocity");
      expect(seen[0].body).toMatchObject({ sex: "male", age_months: 4, days: 30, weight_kg_start: 6, weight_kg_end: 6.6, length_cm_start: 62, length_cm_end: 64 });
    });

    it("preterm posts grams and a monitoring block to /paediatric/preterm", async () => {
      const { seen } = await call(
        h.pediatric_growth_velocity_assessment,
        { population: "preterm", birth_weight_kg: 1.2, lowest_weight_kg: 1.1, days_to_regain_birth_weight: 9, weight_start_kg: 1.3, weight_end_kg: 1.5, interval_days: 10, head_circumference_start_cm: 27, head_circumference_end_cm: 28 },
        envelope
      );
      expect(seen[0].url.pathname).toBe("/paediatric/preterm");
      expect(seen[0].body.weight_g).toBeCloseTo(1500, 5);
      expect(seen[0].body.monitoring).toMatchObject({ days_to_regain_birth_weight: 9, days: 10, hc_cm_start: 27, hc_cm_end: 28 });
      expect(seen[0].body.monitoring.birth_weight_g).toBeCloseTo(1200, 5);
      expect(seen[0].body.monitoring.nadir_weight_g).toBeCloseTo(1100, 5);
    });

    it("preterm with no weight at all makes no request", async () => {
      const { out, seen } = await call(h.pediatric_growth_velocity_assessment, { population: "preterm" }, envelope);
      expect(out.isError).toBe(true);
      expect(seen).toHaveLength(0);
    });
  });

  describe("pediatric_enteral_feed_plan", () => {
    it("posts route, weight and formula to /paediatric/enteral-feeds", async () => {
      const { seen } = await call(h.pediatric_enteral_feed_plan, { feed_type: "continuous", age_months: 9, weight_kg: 8, formula_kcal_per_ml: 1, energy_target_kcal: 700 }, envelope);
      expect(seen[0].url.pathname).toBe("/paediatric/enteral-feeds");
      expect(seen[0].body).toMatchObject({ age_months: 9, weight_kg: 8, route: "continuous", formula_kcal_per_ml: 1, energy_target_kcal: 700 });
    });

    it("needs age and weight and makes no request without them", async () => {
      const a = await call(h.pediatric_enteral_feed_plan, { feed_type: "bolus", weight_kg: 8 }, envelope);
      expect(a.out.isError).toBe(true);
      const b = await call(h.pediatric_enteral_feed_plan, { feed_type: "bolus", age_years: 2 }, envelope);
      expect(b.out.isError).toBe(true);
      expect(a.seen.length + b.seen.length).toBe(0);
    });
  });

  it("surfaces an API error as a tool error", async () => {
    const { out } = await call(h.pediatric_fluid_requirements, { weight_kg: 12 }, { status: "error", message: "bad weight" }, 400);
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain("bad weight");
  });
});
