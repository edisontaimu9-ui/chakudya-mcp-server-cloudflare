import { describe, it, expect, vi, beforeEach } from "vitest";

let binding: { limit: (o: { key: string }) => Promise<{ success: boolean }> } | undefined;

vi.mock("../../config/env.js", () => ({
  getEnv: () => ({ ENVIRONMENT: "development", MCP_AUTH_TOKEN: "t", MCP_RATE_LIMIT_PER_MIN: 2 }),
  getRateLimiterBinding: () => binding,
}));

import { rateLimit } from "../security.js";

const req = (ip: string) => new Request("https://example.test/mcp", { method: "POST", headers: { "cf-connecting-ip": ip } });

describe("rateLimit", () => {
  beforeEach(() => {
    binding = undefined;
  });

  it("uses the binding and keys it by client IP", async () => {
    const seen: string[] = [];
    binding = { limit: async ({ key }) => (seen.push(key), { success: true }) };
    expect(await rateLimit(req("1.1.1.1"))).toBeNull();
    expect(seen).toEqual(["1.1.1.1"]);
  });

  it("returns 429 when the binding says the limit is exceeded", async () => {
    binding = { limit: async () => ({ success: false }) };
    const res = await rateLimit(req("2.2.2.2"));
    expect(res?.status).toBe(429);
    expect(res?.headers.get("Retry-After")).toBe("60");
  });

  it("falls back to the in-memory limiter if the binding throws", async () => {
    binding = { limit: async () => { throw new Error("boom"); } };
    expect(await rateLimit(req("3.3.3.3"))).toBeNull();
    expect(await rateLimit(req("3.3.3.3"))).toBeNull();
    expect((await rateLimit(req("3.3.3.3")))?.status).toBe(429);
  });

  it("uses the in-memory limiter when there is no binding", async () => {
    expect(await rateLimit(req("4.4.4.4"))).toBeNull();
    expect(await rateLimit(req("4.4.4.4"))).toBeNull();
    expect((await rateLimit(req("4.4.4.4")))?.status).toBe(429);
  });
});
