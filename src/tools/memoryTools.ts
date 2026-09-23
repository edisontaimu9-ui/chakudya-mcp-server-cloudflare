import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { chakudyaClient } from "../clients/chakudyaClient.js";
import { ok, safeTool, toolError } from "../utils/toolResult.js";

/**
 * Chakudya's session-scoped memory system — the same session_id already
 * accepted by search_guidelines (rag/ask) in ragTools.ts to personalize
 * answers. Raw facts written via memory_write are periodically consolidated
 * (hourly cron, or manually via memory_consolidate) into the rows that
 * memory_recall searches over.
 *
 * `defaultSessionId` is the current MCP session's `Mcp-Session-Id` (see
 * index.ts, which mints one on `initialize` and expects the client to echo
 * it back on every later request in that session — standard MCP Streamable
 * HTTP behaviour). When the caller omits `session_id` on a call, these tools
 * fall back to it, so a model driving this MCP server gets memory that "just
 * works" across tool calls in one session without ever having to invent or
 * pass a session_id itself.
 *
 * The explicit `session_id` argument still exists and still wins when given
 * — that's what lets a caller deliberately span memory across MCP sessions
 * (e.g. Thanzi Coach keying memory by WhatsApp phone number instead of by
 * MCP session, so a patient's context survives across separate
 * conversations, not just within one).
 *
 * Three tools:
 *   - memory_recall
 *   - memory_write
 *   - memory_consolidate (admin)
 */

export function registerMemoryTools(server: McpServer, defaultSessionId?: string) {
  function resolveSessionId(explicit?: string): { ok: true; sessionId: string } | { ok: false; error: string } {
    const sessionId = explicit ?? defaultSessionId;
    if (!sessionId) {
      return {
        ok: false,
        error:
          "No session_id was given, and no Mcp-Session-Id was available from the current MCP session " +
          "(the client either didn't echo back the header from initialize, or is calling outside of an " +
          "initialized session). Pass session_id explicitly, or ensure your MCP client retains and resends " +
          "the Mcp-Session-Id header it received when the session was initialized.",
      };
    }
    return { ok: true, sessionId };
  }

  // ── memory_recall ────────────────────────────────────────────────────────
  server.registerTool(
    "memory_recall",
    {
      title: "Recall Session Memory",
      description:
        "Recall the top-K memory rows most relevant to a query. Uses the current MCP session automatically " +
        "if session_id is omitted, so a model can just call this without tracking session_id itself. Use " +
        "this to pull back facts previously written with memory_write before answering something that may " +
        "depend on earlier context in the same session.",
      inputSchema: {
        session_id: z
          .string()
          .min(1)
          .optional()
          .describe("Defaults to the current MCP session's Mcp-Session-Id if omitted"),
        query: z.string().min(1),
        top_k: z.number().int().positive().optional().default(5),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("memory_recall", async ({ session_id, query, top_k }) => {
      const resolved = resolveSessionId(session_id);
      if (!resolved.ok) return toolError(resolved.error);
      const res = await chakudyaClient.post("/memory/recall", { session_id: resolved.sessionId, query, top_k });
      return ok(res.data ?? res);
    })
  );

  // ── memory_write ─────────────────────────────────────────────────────────
  server.registerTool(
    "memory_write",
    {
      title: "Write Session Memory",
      description:
        "Write a raw memory fact (e.g. a detail about a patient/case worth recalling later in the same " +
        "session). Uses the current MCP session automatically if session_id is omitted — call this whenever " +
        "something worth remembering for later in the conversation comes up, without needing to invent or " +
        "track a session_id yourself. Written facts are periodically consolidated (hourly cron, or via " +
        "memory_consolidate) into a compact summary, but are searchable via memory_recall right away.",
      inputSchema: {
        session_id: z
          .string()
          .min(1)
          .optional()
          .describe("Defaults to the current MCP session's Mcp-Session-Id if omitted"),
        content: z.string().min(1),
        kind: z.string().optional().default("fact"),
        patient_label: z.string().optional().describe("Optional label to scope the fact to a specific patient/case within the session"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    safeTool("memory_write", async ({ session_id, content, kind, patient_label }) => {
      const resolved = resolveSessionId(session_id);
      if (!resolved.ok) return toolError(resolved.error);
      const res = await chakudyaClient.post("/memory/write", {
        session_id: resolved.sessionId,
        content,
        kind,
        patient_label,
      });
      return ok(res.data ?? res);
    })
  );

  // ── memory_consolidate ───────────────────────────────────────────────────
  server.registerTool(
    "memory_consolidate",
    {
      title: "Consolidate Session Memory (Admin)",
      description:
        "Manually trigger memory consolidation for one session, rather than waiting for the hourly cron. " +
        "Sessions with fewer than 6 unconsolidated facts are skipped (status='skipped'). Requires " +
        "CHAKUDYA_ADMIN_API_KEY to be configured on this MCP server.",
      inputSchema: {
        session_id: z
          .string()
          .min(1)
          .optional()
          .describe("Defaults to the current MCP session's Mcp-Session-Id if omitted"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("memory_consolidate", async ({ session_id }) => {
      const resolved = resolveSessionId(session_id);
      if (!resolved.ok) return toolError(resolved.error);
      const res = await chakudyaClient.post(
        "/memory/consolidate",
        { session_id: resolved.sessionId },
        { useAdminKey: true }
      );
      return ok(res.data ?? res);
    })
  );
}
