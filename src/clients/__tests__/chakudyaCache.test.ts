import { describe, it, expect, beforeEach } from "vitest";
import { initEnv } from "../../config/env.js";
import { chakudyaClient, cacheTtlMs, __clearCacheForTests } from "../chakudyaClient.js";

let hits: string[];
const api = (status = 200) =>
  ({
    fetch: async (input: string) => {
      hits.push(new URL(input).pathname + new URL(input).search);
      return Response.json({ status: status < 400 ? "success" : "error", data: { n: hits.length } }, { status });
    },
  }) as unknown as Fetcher;

const arm = (extra: Record<string, string> = {}, status = 200) =>
  initEnv({ ENVIRONMENT: "development", CHAKUDYA_API: api(status), CHAKUDYA_API_KEY: "k", ...extra });

beforeEach(() => {
  hits = [];
  __clearCacheForTests();
});

describe("lookup cache", () => {
  it("serves repeat calls for the same food from memory", async () => {
    arm();
    const a = await chakudyaClient.get("/foods/42");
    const b = await chakudyaClient.get("/foods/42");
    expect(hits).toHaveLength(1);
    expect(b).toEqual(a);
  });

  it("keys on query parameters, so with_servings is cached separately", async () => {
    arm();
    await chakudyaClient.get("/foods/42");
    await chakudyaClient.get("/foods/42", { with_servings: true });
    await chakudyaClient.get("/foods/42", { with_servings: true });
    expect(hits).toHaveLength(2);
  });

  it("caches categories and labels", async () => {
    arm();
    await chakudyaClient.get("/foods/categories");
    await chakudyaClient.get("/foods/categories");
    await chakudyaClient.get("/foods/42/label", { serving: "cup" });
    await chakudyaClient.get("/foods/42/label", { serving: "cup" });
    expect(hits).toHaveLength(2);
  });

  it("never caches searches, packaged lookups, POSTs or admin calls", async () => {
    arm({ CHAKUDYA_ADMIN_API_KEY: "a" });
    await chakudyaClient.get("/foods", { search: "x" });
    await chakudyaClient.get("/foods", { search: "x" });
    await chakudyaClient.get("/foods/search", { q: "x" });
    await chakudyaClient.get("/foods/search", { q: "x" });
    await chakudyaClient.get("/packaged", { search: "x" });
    await chakudyaClient.get("/packaged", { search: "x" });
    await chakudyaClient.get("/foods/42", undefined, { useAdminKey: true });
    await chakudyaClient.get("/foods/42", undefined, { useAdminKey: true });
    expect(hits).toHaveLength(8);
  });

  it("does not cache errors", async () => {
    arm({}, 404);
    await expect(chakudyaClient.get("/foods/999")).rejects.toBeDefined();
    await expect(chakudyaClient.get("/foods/999")).rejects.toBeDefined();
    expect(hits).toHaveLength(2);
  });

  it("MCP_CACHE_TTL_SECONDS=0 turns caching off", async () => {
    arm({ MCP_CACHE_TTL_SECONDS: "0" });
    await chakudyaClient.get("/foods/42");
    await chakudyaClient.get("/foods/42");
    expect(hits).toHaveLength(2);
  });

  it("returns a copy, so a caller cannot change the cached entry", async () => {
    arm();
    const first = (await chakudyaClient.get("/foods/42")) as { data: { n: number } };
    await chakudyaClient.get("/foods/42");
    first.data.n = 999;
    const again = (await chakudyaClient.get("/foods/42")) as { data: { n: number } };
    expect(again.data.n).not.toBe(999);
  });
});

describe("cacheTtlMs", () => {
  it("only matches the stable routes", () => {
    arm();
    expect(cacheTtlMs("/foods/categories")).toBe(86_400_000);
    expect(cacheTtlMs("/foods/42")).toBe(3_600_000);
    expect(cacheTtlMs("/foods/42/label")).toBe(3_600_000);
    for (const p of ["/foods", "/foods/search", "/foods/lookup", "/foods/autocomplete", "/packaged", "/memory/x", "/rag/ask"]) {
      expect(cacheTtlMs(p), p).toBe(0);
    }
  });
});
