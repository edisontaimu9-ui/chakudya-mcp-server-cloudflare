import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isInitializeRequest, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { initEnv, getEnv, type WorkerBindings } from "./config/env.js";
import { logger } from "./utils/logger.js";
import { createChakudyaMcpServer } from "./server/createServer.js";
import { requireAuth, rateLimit } from "./server/security.js";
import { handleOAuthRoute } from "./server/oauth.js";
import { OneShotTransport } from "./server/mcpTransport.js";

/**
 * Cloudflare Workers entry point. Same MCP surface as the Render deployment
 * (src/index.ts there) — /health, the OAuth discovery endpoints, and /mcp —
 * but as a `fetch(request, env, ctx)` handler instead of an Express app,
 * and running the MCP protocol in stateless mode (see mcpTransport.ts for
 * why). The Render deployment is untouched by any of this; the two run as
 * fully independent services against the same Chakudya API.
 */

function corsHeaders(req: Request): HeadersInit {
  const env = getEnv();
  if (env.MCP_ALLOWED_ORIGINS.length === 0) return {};
  const origin = req.headers.get("origin");
  if (!origin || !env.MCP_ALLOWED_ORIGINS.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id",
    "Access-Control-Expose-Headers": "Mcp-Session-Id",
  };
}

function withCors(res: Response, req: Request): Response {
  const extra = corsHeaders(req);
  for (const [k, v] of Object.entries(extra)) res.headers.set(k, v as string);
  return res;
}

async function handleMcpRequest(req: Request): Promise<Response> {
  const authRejection = requireAuth(req);
  if (authRejection) return authRejection;

  const rateRejection = rateLimit(req);
  if (rateRejection) return rateRejection;

  let body: JSONRPCMessage;
  try {
    body = await req.json();
  } catch {
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32700, message: "Parse error: invalid JSON body" }, id: null },
      { status: 400 }
    );
  }

  // Batched JSON-RPC arrays aren't supported in this stateless build — none
  // of this project's tools need it, and every mainstream MCP client (incl.
  // Claude.ai) sends one message per HTTP request anyway.
  if (Array.isArray(body)) {
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32600, message: "Batched requests are not supported." }, id: null },
      { status: 400 }
    );
  }

  if (!isInitializeRequest(body) && (body as { method?: string }).method === undefined) {
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32600, message: "Invalid Request" }, id: null },
      { status: 400 }
    );
  }

  const transport = new OneShotTransport();
  let server: McpServer | undefined;

  try {
    server = createChakudyaMcpServer();
    await server.connect(transport as any);

    const response = await transport.handle(body);

    if (response === null) {
      // Notification — no reply expected. 202 Accepted, empty body.
      return new Response(null, { status: 202 });
    }
    return Response.json(response);
  } catch (e) {
    logger.error("mcp_request_error", { error: e instanceof Error ? e.message : String(e) });
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null },
      { status: 500 }
    );
  } finally {
    await server?.close().catch(() => {});
  }
}

export default {
  async fetch(request: Request, env: WorkerBindings): Promise<Response> {
    try {
      initEnv(env);
    } catch (e) {
      logger.error("worker_config_error", { error: e instanceof Error ? e.message : String(e) });
      return Response.json({ error: "Server misconfigured. Check Worker secrets/vars." }, { status: 500 });
    }

    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }), request);
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return withCors(
        Response.json({ status: "ok", service: "chakudya-mcp-server-cloudflare", time: new Date().toISOString() }),
        request
      );
    }

    // OAuth discovery/registration/authorize/token — unauthenticated, same
    // as the Render version, since a client has no token yet when it hits
    // these.
    const oauthResponse = await handleOAuthRoute(request);
    if (oauthResponse) return withCors(oauthResponse, request);

    if (url.pathname === "/mcp") {
      if (request.method === "POST") {
        return withCors(await handleMcpRequest(request), request);
      }
      // No standing session to stream over or tear down in stateless mode —
      // see mcpTransport.ts. Clients that only ever POST (every mainstream
      // MCP client, incl. Claude.ai) never hit this.
      if (request.method === "GET" || request.method === "DELETE") {
        return withCors(
          new Response("This deployment runs MCP in stateless mode: only POST /mcp is supported.", {
            status: 405,
            headers: { Allow: "POST" },
          }),
          request
        );
      }
    }

    return withCors(new Response("Not found", { status: 404 }), request);
  },
};
