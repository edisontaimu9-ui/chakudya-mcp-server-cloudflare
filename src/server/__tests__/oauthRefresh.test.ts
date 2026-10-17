import { describe, it, expect, beforeEach } from "vitest";
import { initEnv } from "../../config/env.js";
import { handleOAuthRoute } from "../oauth.js";

const tokenReq = (body: Record<string, string>) =>
  new Request("https://example.test/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("POST /token refresh_token grant", () => {
  beforeEach(() => initEnv({ ENVIRONMENT: "production", MCP_AUTH_TOKEN: "secret-token" }));

  it("does not hand out the token without a refresh token", async () => {
    const res = await handleOAuthRoute(tokenReq({ grant_type: "refresh_token" }));
    expect(res?.status).toBe(400);
    expect(await res?.text()).not.toContain("secret-token");
  });

  it("rejects a wrong refresh token", async () => {
    const res = await handleOAuthRoute(tokenReq({ grant_type: "refresh_token", refresh_token: "nope" }));
    expect(res?.status).toBe(400);
  });

  it("accepts the refresh token that was issued", async () => {
    const res = await handleOAuthRoute(tokenReq({ grant_type: "refresh_token", refresh_token: "secret-token" }));
    expect(res?.status).toBe(200);
    expect((await res?.json() as { access_token: string }).access_token).toBe("secret-token");
  });
});
