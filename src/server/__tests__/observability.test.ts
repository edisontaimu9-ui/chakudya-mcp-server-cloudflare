import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { initEnv } from "../../config/env.js";
import { createChakudyaMcpServer } from "../createServer.js";
import { VERSION } from "../../version.js";
import worker from "../../index.js";

type Tool = { handler: (a: unknown, e: unknown) => Promise<unknown> };
const lines: Record<string, unknown>[] = [];

beforeEach(() => {
  lines.length = 0;
  vi.spyOn(console, "log").mockImplementation((l: string) => void lines.push(JSON.parse(l)));
  vi.spyOn(console, "error").mockImplementation((l: string) => void lines.push(JSON.parse(l)));
  initEnv({ ENVIRONMENT: "production", MCP_AUTH_TOKEN: "t" });
});
afterEach(() => vi.restoreAllMocks());

describe("tool_call logging", () => {
  it("logs tool name, duration and ids, but never the arguments", async () => {
    const server = createChakudyaMcpServer("sess-1", ["screening"], { requestId: "req-9" }) as unknown as {
      _registeredTools: Record<string, Tool & { inputSchema?: { parse: (v: unknown) => unknown } }>;
    };
    const tool = server._registeredTools["must_screen"];
    await tool.handler(tool.inputSchema!.parse({ bmi: 22, weight_loss_band: "lt_5_percent", acute_disease_no_intake_over_5_days: false }), {}).catch(() => {});
    const line = lines.find((l) => l.msg === "tool_call");
    expect(line).toMatchObject({ tool: "must_screen", requestId: "req-9", sessionId: "sess-1" });
    expect(typeof line?.ms).toBe("number");
    expect(JSON.stringify(line)).not.toContain("weight_loss_band");
  });
});

describe("request id and version", () => {
  it("adds X-Request-Id to responses and reuses cf-ray when present", async () => {
    const res = await worker.fetch(new Request("https://x.test/nope", { headers: { "cf-ray": "ray-123" } }), { ENVIRONMENT: "production", MCP_AUTH_TOKEN: "t" } as never);
    expect(res.status).toBe(404);
    expect(res.headers.get("X-Request-Id")).toBe("ray-123");
    expect(lines.find((l) => l.msg === "request")).toMatchObject({ requestId: "ray-123", path: "/nope", status: 404 });
  });

  it("generates an id when there is no cf-ray, and /health reports the version without logging", async () => {
    const res = await worker.fetch(new Request("https://x.test/health"), { ENVIRONMENT: "production", MCP_AUTH_TOKEN: "t" } as never);
    expect(res.headers.get("X-Request-Id")).toMatch(/[0-9a-f-]{36}/);
    expect((await res.json() as { version: string }).version).toBe(VERSION);
    expect(lines.find((l) => l.msg === "request")).toBeUndefined();
  });
});
