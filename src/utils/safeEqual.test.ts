import { describe, it, expect } from "vitest";
import { safeEqual } from "./safeEqual.js";

describe("safeEqual", () => {
  it("matches identical strings", () => expect(safeEqual("abc123", "abc123")).toBe(true));
  it("rejects a different string of the same length", () => expect(safeEqual("abc123", "abc124")).toBe(false));
  it("rejects prefixes and longer strings", () => {
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("abcd", "abc")).toBe(false);
  });
  it("rejects empty vs non-empty and handles unicode", () => {
    expect(safeEqual("", "x")).toBe(false);
    expect(safeEqual("ñ", "ñ")).toBe(true);
  });
});
