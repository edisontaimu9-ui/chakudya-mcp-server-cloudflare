import { describe, it, expect } from "vitest";
import { capResult, ok } from "./toolResult.js";

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i, name: `food ${i}`, note: "x".repeat(50) }));

describe("capResult", () => {
  it("leaves small results untouched, with the same shape as before", () => {
    const d = rows(3);
    expect(capResult(d, undefined, 30_000)).toBe(JSON.stringify(d, null, 2));
    expect(capResult(d, { source: "s" }, 30_000)).toBe(JSON.stringify({ source: "s", data: d }, null, 2));
  });

  it("cuts a long top-level list to fit and says how much was kept", () => {
    const text = capResult(rows(500), { source: "s" }, 5_000);
    expect(text.length).toBeLessThanOrEqual(5_000);
    const out = JSON.parse(text);
    expect(out.source).toBe("s");
    expect(out.truncated.total).toBe(500);
    expect(out.truncated.returned).toBe(out.data.length);
    expect(out.data.length).toBeGreaterThan(5);
    expect(out.data[0].id).toBe(0);
  });

  it("cuts the largest array inside an object result", () => {
    const text = capResult({ answer: "ok", results: rows(400), small: [1] }, undefined, 5_000);
    const out = JSON.parse(text);
    expect(text.length).toBeLessThanOrEqual(5_000);
    expect(out.truncated.field).toBe("results");
    expect(out.data.answer).toBe("ok");
    expect(out.data.small).toEqual([1]);
    expect(out.data.results.length).toBe(out.truncated.returned);
  });

  it("returns a flagged preview when there is no list to cut", () => {
    const text = capResult({ big: "y".repeat(50_000) }, undefined, 5_000);
    const out = JSON.parse(text);
    expect(text.length).toBeLessThanOrEqual(5_000);
    expect(out.truncated.originalChars).toBeGreaterThan(50_000);
    expect(typeof out.preview).toBe("string");
  });

  it("ok() applies the cap using the default when env isn't initialised", () => {
    const res = ok(rows(2_000));
    expect(res.content[0].text.length).toBeLessThanOrEqual(30_000);
    expect(JSON.parse(res.content[0].text).truncated.total).toBe(2_000);
  });
});
