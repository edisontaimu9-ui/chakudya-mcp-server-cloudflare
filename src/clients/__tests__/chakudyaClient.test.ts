import { describe, it, expect } from "vitest";
import { initEnv } from "../../config/env.js";
import { chakudyaClient, ChakudyaApiError } from "../chakudyaClient.js";

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
