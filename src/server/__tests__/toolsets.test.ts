import { describe, it, expect } from "vitest";
import { initEnv } from "../../config/env.js";
import { createChakudyaMcpServer } from "../createServer.js";
import { TOOLSETS, TOOLSET_NAMES, parseToolsets } from "../toolsets.js";

const toolNames = (toolsets?: string[] | null) => {
  initEnv({ ENVIRONMENT: "development" });
  const s = createChakudyaMcpServer("t", toolsets) as unknown as { _registeredTools: Record<string, unknown> };
  return Object.keys(s._registeredTools).sort();
};

describe("parseToolsets", () => {
  it("means no filter when absent, empty or 'all'", () => {
    for (const v of [null, "", "  ", "all", "ALL", "food,all"]) {
      expect(parseToolsets(v)).toEqual({ selected: null, unknown: [] });
    }
  });
  it("normalises case, spacing and duplicates", () => {
    expect(parseToolsets(" Food , SCREENING,food ")).toEqual({ selected: ["food", "screening"], unknown: [] });
  });
  it("reports unknown names", () => {
    expect(parseToolsets("food,nope")).toEqual({ selected: ["food"], unknown: ["nope"] });
  });
});

describe("toolsets", () => {
  it("default exposes every tool", () => {
    expect(toolNames().length).toBe(toolNames(TOOLSET_NAMES).length);
    expect(toolNames(null).length).toBeGreaterThan(100);
  });

  it("each toolset registers tools, and the toolsets don't overlap", () => {
    const seen = new Map<string, string>();
    for (const name of TOOLSET_NAMES) {
      const names = toolNames([name]);
      expect(names.length, `${name} has no tools`).toBeGreaterThan(0);
      for (const n of names) {
        expect(seen.get(n), `${n} is in both ${seen.get(n)} and ${name}`).toBeUndefined();
        seen.set(n, name);
      }
    }
    expect(seen.size).toBe(toolNames().length);
  });

  it("a filtered server exposes only the chosen tools", () => {
    const food = toolNames(["food"]);
    expect(food).toContain("search_food");
    expect(food).not.toContain("must_screen");
    expect(toolNames(["screening"])).toContain("must_screen");
  });

  it("every toolset has a description", () => {
    for (const t of Object.values(TOOLSETS)) expect(t.description.length).toBeGreaterThan(10);
  });
});
