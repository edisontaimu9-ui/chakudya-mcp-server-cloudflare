import { describe, it, expect } from "vitest";
import { initEnv } from "../../config/env.js";
import { computeWhoGrowthZScore } from "../whoGrowthTools.js";
import { bmiForAgeSeverity, bmiForAgeStatusFromWhoLabel, fetchBmiForAge, type BmiForAgeStatus } from "../bmiForAgeTools.js";

describe("bmiForAgeSeverity", () => {
  it("maps the endpoint's statuses onto NACS severities", () => {
    expect(bmiForAgeSeverity("severe thinness")).toBe("severe");
    expect(bmiForAgeSeverity("thinness")).toBe("moderate");
    expect(bmiForAgeSeverity("normal")).toBe("normal");
    expect(bmiForAgeSeverity("overweight")).toBe("overweight");
    expect(bmiForAgeSeverity("obesity")).toBe("obesity");
  });
});

describe("bmiForAgeStatusFromWhoLabel — must stay in step with who_growth_zscore's bmi_for_age_5_19y labels", () => {
  it("maps every label the calculator can produce for that standard", () => {
    const seen = new Set<string>();
    // sweep BMI values for a 9-year-old girl to reach every category
    for (let bmi = 8; bmi <= 40; bmi += 0.25) {
      const r = computeWhoGrowthZScore({ standard: "bmi_for_age_5_19y", sex: "female", value: bmi, age_months: 108 });
      if (r.ok) seen.add(r.result.classification);
    }
    expect([...seen].sort()).toEqual(["normal", "obese", "overweight", "severely thin", "thin"]);
    const mapped = [...seen].map((l) => bmiForAgeStatusFromWhoLabel(l));
    expect(mapped.includes(undefined)).toBe(false);
  });

  it("returns undefined for an unknown label", () => {
    expect(bmiForAgeStatusFromWhoLabel("wasted")).toBeUndefined();
  });

  it("agrees with the API's own worked example (girl, 95 months, 26.0 kg, 121.1 cm = overweight)", () => {
    const r = computeWhoGrowthZScore({ standard: "bmi_for_age_5_19y", sex: "female", value: 26 / (1.211 * 1.211), age_months: 95 });
    expect(r.ok && bmiForAgeStatusFromWhoLabel(r.result.classification)).toBe("overweight" satisfies BmiForAgeStatus);
  });
});

describe("fetchBmiForAge — request shape and response validation", () => {
  initEnv({ CHAKUDYA_API_BASE_URL: "https://api.test", ENVIRONMENT: "development" });

  async function withFetch<T>(impl: (url: URL) => Response, fn: () => Promise<T>): Promise<{ result: T; urls: URL[] }> {
    const original = globalThis.fetch;
    const urls: URL[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const u = new URL(String(input));
      urls.push(u);
      return impl(u);
    }) as typeof fetch;
    try {
      return { result: await fn(), urls };
    } finally {
      globalThis.fetch = original;
    }
  }

  const okBody = { status: "success", data: { sex: "girls", age_months: 95, status: "overweight", bmi: 17.7, cutoffs: { "+1SD": 17.7 }, source: "s" } };

  it("sends sex=girls/boys, whole-month age, and weight+height (not bmi) when both are given", async () => {
    const { result, urls } = await withFetch(
      () => new Response(JSON.stringify(okBody), { status: 200 }),
      () => fetchBmiForAge({ sex: "female", age_months: 95, weight_kg: 26, height_cm: 121.1, bmi: 17 })
    );
    expect(result.status).toBe("overweight");
    const u = urls[0];
    expect(u.pathname).toBe("/bmi-for-age/classify");
    expect(u.searchParams.get("sex")).toBe("girls");
    expect(u.searchParams.get("age_months")).toBe("95");
    expect(u.searchParams.get("weight_kg")).toBe("26");
    expect(u.searchParams.get("height_cm")).toBe("121.1");
    expect(u.searchParams.get("bmi")).toBeNull();
  });

  it("sends bmi when only bmi is available, and boys for male", async () => {
    const { urls } = await withFetch(
      () => new Response(JSON.stringify(okBody), { status: 200 }),
      () => fetchBmiForAge({ sex: "male", age_months: 120, bmi: 15.2 })
    );
    expect(urls[0].searchParams.get("sex")).toBe("boys");
    expect(urls[0].searchParams.get("bmi")).toBe("15.2");
    expect(urls[0].searchParams.get("weight_kg")).toBeNull();
  });

  it("rejects an unexpected response body", async () => {
    let threw = false;
    await withFetch(
      () => new Response(JSON.stringify({ status: "success", data: { status: "chubby" } }), { status: 200 }),
      async () => {
        try {
          await fetchBmiForAge({ sex: "male", age_months: 120, bmi: 15.2 });
        } catch {
          threw = true;
        }
      }
    );
    expect(threw).toBe(true);
  });

  it("surfaces API errors (e.g. 400 out-of-range) as thrown errors", async () => {
    let message = "";
    await withFetch(
      () => new Response(JSON.stringify({ status: "error", message: "'age_months' must be 61 (5y 1m) to 228 (19y 0m)." }), { status: 400 }),
      async () => {
        try {
          await fetchBmiForAge({ sex: "male", age_months: 40, bmi: 15.2 });
        } catch (e) {
          message = (e as Error).message;
        }
      }
    );
    expect(message).toMatch(/age_months/);
  });
});
