import { describe, it, expect } from "vitest";
import { TtlCache } from "./ttlCache.js";

describe("TtlCache", () => {
  it("returns a value until it expires", () => {
    const c = new TtlCache<string>();
    c.set("a", "x", 1000, 0);
    expect(c.get("a", 999)).toBe("x");
    expect(c.get("a", 1000)).toBeUndefined();
    expect(c.size).toBe(0);
  });
  it("ignores a zero or negative ttl", () => {
    const c = new TtlCache<string>();
    c.set("a", "x", 0);
    expect(c.get("a")).toBeUndefined();
  });
  it("evicts the least recently used entry past the cap", () => {
    const c = new TtlCache<number>(2);
    c.set("a", 1, 1000, 0);
    c.set("b", 2, 1000, 0);
    c.get("a", 1); // a is now more recent than b
    c.set("c", 3, 1000, 2);
    expect(c.get("b", 3)).toBeUndefined();
    expect(c.get("a", 3)).toBe(1);
    expect(c.get("c", 3)).toBe(3);
  });
});
