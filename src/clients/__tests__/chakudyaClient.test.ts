import { describe, it, expect } from "vitest";
import { initEnv } from "../../config/env.js";
import { chakudyaClient, ChakudyaApiError, __setRetryBaseMsForTests } from "../chakudyaClient.js";

interface Seen { url: string; headers: Record<string, string>; method: string }

/** Fake chakudya-api service binding that records what the client sends. */
function fakeBinding(seen: Seen[], status = 200) {
  return {
    fetch: async (url: string, init: RequestInit) => {
      seen.push({ url, headers: { ...(init.headers as Record<string, string>) }, method: String(init.method) });
      return new Response(JSON.stringify({ status: "success", data: [] }), { status, headers: { "content-type": "application/json" } });
    },
  } as unknown as Fetcher;
}

function setup(extra: Record<string, string> = {}, status = 200) {
  const seen: Seen[] = [];
  initEnv({ ENVIRONMENT: "development", CHAKUDYA_API: fakeBinding(seen, status), ...extra });
  return seen;
}

describe("chakudyaClient auth", () => {
  it("sends the consumer key on a normal call", async () => {
    const seen = setup({ CHAKUDYA_API_KEY: "cnr_consumer", CHAKUDYA_ADMIN_API_KEY: "cnr_admin" });
    await chakudyaClient.get("/foods/categories");
    expect(seen[0].headers.Authorization).toBe("Bearer cnr_consumer");
  });

  it("sends the consumer key on POST and DELETE too", async () => {
    const seen = setup({ CHAKUDYA_API_KEY: "cnr_consumer" });
    await chakudyaClient.post("/rag/ask", { query: "x" });
    await chakudyaClient.del("/log/1", undefined, { params: { user_id: "u" } });
    expect(seen.map((s) => s.headers.Authorization)).toEqual(["Bearer cnr_consumer", "Bearer cnr_consumer"]);
  });

  it("uses the admin key, not the consumer key, on admin-gated routes", async () => {
    const seen = setup({ CHAKUDYA_API_KEY: "cnr_consumer", CHAKUDYA_ADMIN_API_KEY: "cnr_admin" });
    await chakudyaClient.get("/packaged/pending", undefined, { useAdminKey: true });
    expect(seen[0].headers.Authorization).toBe("Bearer cnr_admin");
  });

  it("fails clearly when an admin route is called without an admin key", async () => {
    setup({ CHAKUDYA_API_KEY: "cnr_consumer" });
    await expect(chakudyaClient.get("/packaged/pending", undefined, { useAdminKey: true })).rejects.toBeInstanceOf(ChakudyaApiError);
  });

  it("sends no Authorization header when no consumer key is configured (the API will answer 401)", async () => {
    const seen = setup();
    await chakudyaClient.get("/foods/categories");
    expect(seen[0].headers.Authorization).toBeUndefined();
  });

  it("surfaces a 401 from the API as a ChakudyaApiError", async () => {
    setup({ CHAKUDYA_API_KEY: "cnr_bad" }, 401);
    await expect(chakudyaClient.get("/foods/categories")).rejects.toMatchObject({ status: 401 });
  });
});

describe("chakudyaClient retries", () => {
  function flaky(statuses: number[], seen: string[]) {
    let i = 0;
    return {
      fetch: async (_url: string, init: RequestInit) => {
        const status = statuses[Math.min(i++, statuses.length - 1)];
        seen.push(String(init.method));
        if (status === -1) throw new Error("connection reset");
        return new Response(JSON.stringify({ status: "success", data: [] }), { status, headers: { "content-type": "application/json" } });
      },
    } as unknown as Fetcher;
  }
  const arm = (statuses: number[]) => {
    const seen: string[] = [];
    initEnv({ ENVIRONMENT: "development", CHAKUDYA_API: flaky(statuses, seen) });
    __setRetryBaseMsForTests(1);
    return seen;
  };

  it("retries a GET once after a 503 and succeeds", async () => {
    const seen = arm([503, 200]);
    await expect(chakudyaClient.get("/foods/categories")).resolves.toBeDefined();
    expect(seen).toHaveLength(2);
  });

  it("retries a GET once after a network error", async () => {
    const seen = arm([-1, 200]);
    await chakudyaClient.get("/foods/categories");
    expect(seen).toHaveLength(2);
  });

  it("gives up after one retry and surfaces the status", async () => {
    const seen = arm([503, 503, 200]);
    await expect(chakudyaClient.get("/foods/categories")).rejects.toMatchObject({ status: 503 });
    expect(seen).toHaveLength(2);
  });

  it("does not retry non-retryable statuses like 404 or 401", async () => {
    const seen = arm([404, 200]);
    await expect(chakudyaClient.get("/foods/1")).rejects.toMatchObject({ status: 404 });
    expect(seen).toHaveLength(1);
  });

  it("never retries POST or DELETE", async () => {
    const seen = arm([503, 200]);
    await expect(chakudyaClient.post("/rag/ask", { query: "x" })).rejects.toMatchObject({ status: 503 });
    expect(seen).toHaveLength(1);
  });
});
