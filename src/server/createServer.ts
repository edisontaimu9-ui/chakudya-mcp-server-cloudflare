import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOLSETS } from "./toolsets.js";

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
export function createChakudyaMcpServer(sessionId?: string, toolsets?: string[] | null): McpServer {
  const server = new McpServer({
    name: "chakudya-nutrition-registry",
    version: "1.0.0",
  });

  const chosen = toolsets && toolsets.length > 0 ? toolsets : Object.keys(TOOLSETS);
  for (const name of chosen) {
    for (const register of TOOLSETS[name]?.register ?? []) register(server, sessionId);
  }

  return server;
}
