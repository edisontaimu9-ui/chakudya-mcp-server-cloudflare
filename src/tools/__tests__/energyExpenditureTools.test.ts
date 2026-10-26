import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { initEnv } from "../../config/env.js";
import { registerEnergyExpenditureTools } from "../energyExpenditureTools.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;

function collect() {
  const handlers: Record<string, Handler> = {};
  const fake = { registerTool: (name: string, _cfg: unknown, h: Handler) => void (handlers[name] = h) } as unknown as McpServer;
  registerEnergyExpenditureTools(fake);
  return handlers;
}

type Seen = { url: URL; method: string; body: any };

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

describe("energy expenditure tools call chakudya-api", () => {
  initEnv({ CHAKUDYA_API_BASE_URL: "https://api.test", ENVIRONMENT: "development" });
  const h = collect();
  const envelope = { status: "success", data: { marker: "from-api", disclaimer: "the disclaimer", citation: "the citation" } };

  const factors = {
    status: "success",
    data: {
      activity_factors: [
        { id: "minimal", label: "Minimal", min: 0.1, max: 0.2 },
        { id: "moderate", label: "Moderate", min: 0.25, max: 0.4 },
        { id: "strenuous", label: "Strenuous", min: 0.45, max: 0.6 },
      ],
      activities: [
        { id: "walking_3mph", label: "Walking (3 mph)", mets: 3.3 },
        { id: "mowing_lawn_power_mower", label: "Mowing lawn (power mower)", mets: 4.5 },
        { id: "skiing", label: "Skiing", mets: 6.8 },
        { id: "jogging_10_min_mile", label: "Jogging", mets: 10.2 },
      ],
      dri_reference_eer: [
        { group: "Children 3-8 years", male: 1742, female: 1642 },
        { group: "Adults over 18 years", male: 3067, female: 2403 },
        { group: "Lactating 19-50 years, first 6 months", female: 2733 },
      ],
    },
  };

  it("registers all eight tools under their original names", () => {
    for (const n of [
      "iom_dri_eer_calculator",
      "met_activity_energy_calculator",
      "alcohol_kcal_calculator",
      "respiratory_quotient_interpreter",
      "tee_activity_band_estimator",
      "fever_stress_ree_adjustment",
      "atwater_food_energy_calculator",
      "dri_eer_reference_lookup",
    ])
      expect(h[n], n).toBeTypeOf("function");
  });

  describe("iom_dri_eer_calculator", () => {
    const base = { weight_kg: 60, height_cm: 165, age_years: 25, physical_activity_level: "active" };

    it("derives sex from the life stage and posts to /energy/requirements", async () => {
      const f = await call(h.iom_dri_eer_calculator, { life_stage: "adult_female_normal_bmi18_25", ...base }, envelope);
      expect(f.seen[0].method).toBe("POST");
      expect(f.seen[0].url.pathname).toBe("/energy/requirements");
      expect(f.seen[0].body).toMatchObject({ sex: "female", weight_kg: 60, height_cm: 165, age_years: 25, pal_category: "active" });
      expect(f.seen[0].body.pregnancy).toBeUndefined();
      expect(f.seen[0].body.lactation).toBeUndefined();
      const m = await call(h.iom_dri_eer_calculator, { life_stage: "adult_male_overweight_obese_bmi25plus", ...base }, envelope);
      expect(m.seen[0].body.sex).toBe("male");
      const g = await call(h.iom_dri_eer_calculator, { life_stage: "child_girl_9_18_normal", ...base, age_years: 12 }, envelope);
      expect(g.seen[0].body.sex).toBe("female");
      const b = await call(h.iom_dri_eer_calculator, { life_stage: "child_boy_3_8_normal", ...base, age_years: 6 }, envelope);
      expect(b.seen[0].body.sex).toBe("male");
    });

    it("maps lactation half-years to months postpartum (first 6 months -> 3, second -> 9)", async () => {
      const a = await call(h.iom_dri_eer_calculator, { life_stage: "lactating_19_50", ...base, months_postpartum: "first_6_months" }, envelope);
      expect(a.seen[0].body.sex).toBe("female");
      expect(a.seen[0].body.lactation).toEqual({ months_postpartum: 3 });
      const b = await call(h.iom_dri_eer_calculator, { life_stage: "lactating_14_18", ...base, age_years: 16, months_postpartum: "second_6_months" }, envelope);
      expect(b.seen[0].body.lactation).toEqual({ months_postpartum: 9 });
    });

    it("maps trimester names to numbers", async () => {
      const a = await call(h.iom_dri_eer_calculator, { life_stage: "pregnant_19_50", ...base, trimester: "second" }, envelope);
      expect(a.seen[0].body.pregnancy).toEqual({ trimester: 2 });
      const b = await call(h.iom_dri_eer_calculator, { life_stage: "pregnant_19_50", ...base, trimester: "third" }, envelope);
      expect(b.seen[0].body.pregnancy).toEqual({ trimester: 3 });
    });

    it("sends infants by month, with a default sex and no activity level", async () => {
      const { seen } = await call(h.iom_dri_eer_calculator, { life_stage: "infant_0_2y", weight_kg: 8, age_months: 8 }, envelope);
      expect(seen[0].body).toMatchObject({ sex: "male", weight_kg: 8, age_months: 8 });
      expect(seen[0].body.pal_category).toBeUndefined();
      const g = await call(h.iom_dri_eer_calculator, { life_stage: "infant_0_2y", weight_kg: 8, age_months: 8, sex: "female" }, envelope);
      expect(g.seen[0].body.sex).toBe("female");
    });

    it("rejects missing trimester, postpartum period or infant age without calling the API", async () => {
      const a = await call(h.iom_dri_eer_calculator, { life_stage: "pregnant_19_50", ...base }, envelope);
      const b = await call(h.iom_dri_eer_calculator, { life_stage: "lactating_19_50", ...base }, envelope);
      const c = await call(h.iom_dri_eer_calculator, { life_stage: "infant_0_2y", weight_kg: 8 }, envelope);
      for (const r of [a, b, c]) {
        expect(r.out.isError).toBe(true);
        expect(r.seen).toHaveLength(0);
      }
    });
  });

  describe("met_activity_energy_calculator", () => {
    it("reads the MET from the API table and multiplies MET x kg x hours", async () => {
      const { out, seen } = await call(h.met_activity_energy_calculator, { weight_kg: 70, duration_minutes: 30, activity: "walking_3mph" }, factors);
      expect(seen[0].url.pathname).toBe("/energy/factors");
      const r = JSON.parse(out.content[0].text);
      expect(r).toMatchObject({ activity: "walking_3mph", met_value: 3.3 });
      expect(r.kcal_expended).toBe(Math.round(3.3 * 70 * 0.5 * 10) / 10);
    });

    it("still accepts the three activity ids spelled differently before the move", async () => {
      for (const [old, now] of [["mowing_lawn_power", "mowing_lawn_power_mower"], ["skiing_downhill_or_water", "skiing"], ["jogging_10min_mile", "jogging_10_min_mile"]]) {
        const { out } = await call(h.met_activity_energy_calculator, { weight_kg: 60, duration_minutes: 60, activity: old }, factors);
        expect(out.isError, old).toBeUndefined();
        expect(JSON.parse(out.content[0].text).activity).toBe(now);
      }
    });

    it("lists the valid ids for an unknown activity", async () => {
      const { out } = await call(h.met_activity_energy_calculator, { weight_kg: 60, duration_minutes: 60, activity: "juggling" }, factors);
      expect(out.isError).toBe(true);
      expect(out.content[0].text).toContain("walking_3mph");
    });

    it("a custom MET value needs no API call", async () => {
      const { out, seen } = await call(h.met_activity_energy_calculator, { weight_kg: 80, duration_minutes: 45, met_value: 6 }, factors);
      expect(seen).toHaveLength(0);
      const r = JSON.parse(out.content[0].text);
      expect(r.activity).toBe("custom");
      expect(r.kcal_expended).toBe(360);
    });

    it("needs an activity or a MET value", async () => {
      const { out, seen } = await call(h.met_activity_energy_calculator, { weight_kg: 80, duration_minutes: 45 }, factors);
      expect(out.isError).toBe(true);
      expect(seen).toHaveLength(0);
    });
  });

  it("alcohol posts the drink to /energy/food-energy", async () => {
    const { seen, out } = await call(h.alcohol_kcal_calculator, { volume_oz: 1.5, proof: 80 }, envelope);
    expect(seen[0].url.pathname).toBe("/energy/food-energy");
    expect(seen[0].body).toEqual({ alcohol: { volume_oz: 1.5, proof: 80 } });
    expect(out.content[0].text).toContain("the disclaimer");
  });

  it("atwater posts the four gram values to /energy/food-energy", async () => {
    const { seen } = await call(h.atwater_food_energy_calculator, { protein_g: 20, fat_g: 10, carbohydrate_g: 50, alcohol_g: 0 }, envelope);
    expect(seen[0].url.pathname).toBe("/energy/food-energy");
    expect(seen[0].body).toEqual({ protein_g: 20, fat_g: 10, carbohydrate_g: 50, alcohol_g: 0 });
  });

  it("fever adjustment still posts to /stress-factors/fever", async () => {
    const { seen } = await call(h.fever_stress_ree_adjustment, { ree_kcal_per_day: 1500, body_temp_c: 39 }, envelope);
    expect(seen[0].url.pathname).toBe("/stress-factors/fever");
  });

  describe("tee_activity_band_estimator", () => {
    it("turns the API's band fractions into REE multipliers", async () => {
      const { out, seen } = await call(h.tee_activity_band_estimator, { ree_kcal_per_day: 1500, activity_level: "minimal" }, factors);
      expect(seen[0].url.pathname).toBe("/energy/factors");
      const r = JSON.parse(out.content[0].text);
      expect(r.multiplier_range).toEqual([1.1, 1.2]);
      expect(r.tee_kcal_per_day_estimate).toEqual({ low: 1650, high: 1800 });
      const s = JSON.parse((await call(h.tee_activity_band_estimator, { ree_kcal_per_day: 1500, activity_level: "strenuous" }, factors)).out.content[0].text);
      expect(s.multiplier_range).toEqual([1.45, 1.6]);
      expect(s.tee_kcal_per_day_estimate).toEqual({ low: 2175, high: 2400 });
    });

    it("errors when the API has no such band", async () => {
      const { out } = await call(h.tee_activity_band_estimator, { ree_kcal_per_day: 1500, activity_level: "moderate" }, { status: "success", data: { activity_factors: [] } });
      expect(out.isError).toBe(true);
    });
  });

  describe("dri_eer_reference_lookup", () => {
    it("returns the full Table 2.2 from the API, or the rows matching a search", async () => {
      const all = await call(h.dri_eer_reference_lookup, {}, factors);
      expect(all.seen[0].url.pathname).toBe("/energy/factors");
      expect(JSON.parse(all.out.content[0].text).results).toHaveLength(3);
      const some = await call(h.dri_eer_reference_lookup, { life_stage_search: "adults" }, factors);
      const rows = JSON.parse(some.out.content[0].text).results;
      expect(rows).toHaveLength(1);
      expect(rows[0].female).toBe(2403);
    });

    it("errors when nothing matches", async () => {
      const { out } = await call(h.dri_eer_reference_lookup, { life_stage_search: "zzz" }, factors);
      expect(out.isError).toBe(true);
    });
  });

  it("respiratory_quotient_interpreter stays local and makes no request", async () => {
    const { out, seen } = await call(h.respiratory_quotient_interpreter, { rq: 0.85 }, envelope);
    expect(seen).toHaveLength(0);
    expect(out.content[0].text).toContain("mixed diet");
  });

  it("surfaces an API error as a tool error", async () => {
    const { out } = await call(h.alcohol_kcal_calculator, { volume_oz: 1, proof: 80 }, { status: "error", message: "bad drink" }, 400);
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain("bad drink");
  });
});
