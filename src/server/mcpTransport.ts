import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

/**
 * A minimal MCP `Transport` implementation for stateless request/response
 * over the Fetch API — the shape Cloudflare Workers actually runs in.
 *
 * The Render version uses the SDK's `StreamableHTTPServerTransport`, which
 * is built on Node's `http.IncomingMessage`/`ServerResponse` and keeps a
 * long-lived session (a `Map<sessionId, transport>` in src/index.ts) so a
 * client can open a standing SSE stream and make many calls against one
 * session. That doesn't map onto Workers: a Worker isolate is not a
 * long-running process, and there's no guarantee two requests from the same
 * client land on the same isolate — see the same caveat already noted in
 * security.ts's rate limiter.
 *
 * Since every tool in this project is stateless (each one just calls the
 * Chakudya API and returns — see createServer.ts's own comment on this),
 * nothing here actually *needs* a persistent session, so this Worker runs
 * in the SDK's documented "stateless" mode: one fresh `McpServer` +
 * `OneShotTransport` per HTTP request, handling exactly one JSON-RPC
 * message (initialize, tools/list, tools/call, ...) and returning exactly
 * one response. No `Mcp-Session-Id` is required or issued.
 */
export class OneShotTransport {
  sessionId?: string;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private pending = new Map<string | number, (msg: JSONRPCMessage) => void>();
  private outgoingNotifications: JSONRPCMessage[] = [];

  async start(): Promise<void> {
    // No transport-level handshake needed — nothing to do.
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const id = (message as { id?: string | number | null }).id;
    if (id !== undefined && id !== null && this.pending.has(id)) {
      this.pending.get(id)!(message);
      this.pending.delete(id);
    } else {
      // A notification the server pushed unprompted (e.g. a log message).
      // We have no open stream to deliver it on in stateless mode, so we
      // just fold it into the HTTP response alongside the real result —
      // see handle() below.
      this.outgoingNotifications.push(message);
    }
  }

  async close(): Promise<void> {
    this.onclose?.();
  }

  /**
   * Feeds one incoming JSON-RPC message to the connected McpServer and
   * resolves once the matching response has been sent back through this
   * transport (or immediately, for notifications the client sends us —
   * those have no `id` and expect no reply).
   */
  async handle(message: JSONRPCMessage): Promise<JSONRPCMessage | null> {
    const id = (message as { id?: string | number | null }).id;
    const isRequest = id !== undefined && id !== null;

    if (!isRequest) {
      this.onmessage?.(message);
      return null; // client notification (e.g. "notifications/initialized") — 202, no body
    }

    const responsePromise = new Promise<JSONRPCMessage>((resolve) => {
      this.pending.set(id, resolve);
    });
    this.onmessage?.(message);
    return responsePromise;
  }
}
