import { describe, it, expect, vi, beforeEach } from "vitest";

const envState: { ENVIRONMENT: string; MCP_AUTH_TOKEN?: string; MCP_ALLOW_QUERY_TOKEN?: boolean } = { ENVIRONMENT: "production" };

vi.mock("../../config/env.js", () => ({
  getEnv: () => ({ ...envState, MCP_RATE_LIMIT_PER_MIN: 60 }),
}));

import { requireAuth } from "../security.js";

const req = (headers: Record<string, string> = {}, path = "/mcp") =>
  new Request(`https://example.test${path}`, { method: "POST", headers });

describe("requireAuth", () => {
  beforeEach(() => {
    envState.ENVIRONMENT = "production";
    envState.MCP_AUTH_TOKEN = undefined;
    envState.MCP_ALLOW_QUERY_TOKEN = false;
  });

  it("fails closed (503) when no token is configured outside development", () => {
    const res = requireAuth(req());
    expect(res?.status).toBe(503);
  });

  it("still fails closed when a client sends a token but none is configured", () => {
    const res = requireAuth(req({ authorization: "Bearer anything" }));
    expect(res?.status).toBe(503);
  });

  it("allows unauthenticated requests only in development", () => {
    envState.ENVIRONMENT = "development";
    expect(requireAuth(req())).toBeNull();
  });

  it("rejects a missing or wrong token with 401 when configured", () => {
    envState.MCP_AUTH_TOKEN = "secret";
    expect(requireAuth(req())?.status).toBe(401);
    expect(requireAuth(req({ authorization: "Bearer wrong" }))?.status).toBe(401);
  });

  it("accepts the correct bearer token", () => {
    envState.MCP_AUTH_TOKEN = "secret";
    expect(requireAuth(req({ authorization: "Bearer secret" }))).toBeNull();
  });

  it("ignores ?token= in the URL by default", () => {
    envState.MCP_AUTH_TOKEN = "secret";
    expect(requireAuth(req({}, "/mcp?token=secret"))?.status).toBe(401);
  });

  it("accepts ?token= only when explicitly enabled", () => {
    envState.MCP_AUTH_TOKEN = "secret";
    envState.MCP_ALLOW_QUERY_TOKEN = true;
    expect(requireAuth(req({}, "/mcp?token=secret"))).toBeNull();
    expect(requireAuth(req({}, "/mcp?token=wrong"))?.status).toBe(401);
  });
});
