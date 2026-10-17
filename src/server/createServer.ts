import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOLSETS } from "./toolsets.js";
import { VERSION } from "../version.js";
import { logger } from "../utils/logger.js";

/**
 * Wraps registerTool so every tool call logs one `tool_call` line: tool name,
 * duration, and whether it returned an error result. Arguments and results are
 * deliberately NOT logged (they can contain a user's food log or memory text).
 * Done here, once, so all tools are covered without touching each module.
 */
function instrumentTools(server: McpServer, ids: { sessionId?: string; requestId?: string }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = server as any;
  const original = s.registerTool.bind(server);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  s.registerTool = (name: string, config: unknown, cb: (...a: any[]) => Promise<any>) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    original(name, config, async (...args: any[]) => {
      const start = Date.now();
      try {
        const res = await cb(...args);
        logger.info("tool_call", { tool: name, ms: Date.now() - start, isError: res?.isError === true, ...ids });
        return res;
      } catch (e) {
        logger.warn("tool_call", { tool: name, ms: Date.now() - start, threw: true, ...ids });
        throw e;
      }
    });
}

/**
 * Builds a new McpServer instance with the Chakudya tools registered: every tool by
 * default, or only the named toolsets (see toolsets.ts) when `toolsets` is given.
 *
 * A fresh instance is created per HTTP request (see src/index.ts) — nearly
 * every tool here is stateless (it just calls the Chakudya API and returns),
 * so rebuilding is cheap. The exception is memory: `sessionId` is this
 * request's MCP session identity (the `Mcp-Session-Id` header — see
 * index.ts for where it's minted/read), threaded into registerMemoryTools()
 * so memory_write/memory_recall/memory_consolidate can default to it
 * without the caller having to pass session_id on every call. The
 * server instance itself still holds no state between requests — the actual
 * memory lives in chakudya-api/Supabase, keyed by that session id.
 */
export function createChakudyaMcpServer(
  sessionId?: string,
  toolsets?: string[] | null,
  ctx: { requestId?: string } = {}
): McpServer {
  const server = new McpServer({
    name: "chakudya-nutrition-registry",
    version: VERSION,
  });
  instrumentTools(server, { sessionId, requestId: ctx.requestId });

  const chosen = toolsets && toolsets.length > 0 ? toolsets : Object.keys(TOOLSETS);
  for (const name of chosen) {
    for (const register of TOOLSETS[name]?.register ?? []) register(server, sessionId);
  }

  return server;
}
