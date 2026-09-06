import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { chakudyaClient } from "../clients/chakudyaClient.js";
import { ok, safeTool } from "../utils/toolResult.js";

/**
 * Chakudya's session-scoped memory system — the same session_id already
 * accepted by search_guidelines (rag/ask) in ragTools.ts to personalize
 * answers. Raw facts written via memory_write are periodically consolidated
 * (hourly cron, or manually via memory_consolidate) into the rows that
 * memory_recall searches over.
 *
 * Three tools:
 *   - memory_recall
 *   - memory_write
 *   - memory_consolidate (admin)
 */

export function registerMemoryTools(server: McpServer) {
  // ── memory_recall ────────────────────────────────────────────────────────
  server.registerTool(
    "memory_recall",
    {
      title: "Recall Session Memory",
      description:
        "Recall the top-K memory rows most relevant to a query, for a given session_id. Use this to pull " +
        "back facts previously written with memory_write (once consolidated) before answering something " +
        "that may depend on earlier context in the same session.",
      inputSchema: {
        session_id: z.string().min(1),
        query: z.string().min(1),
        top_k: z.number().int().positive().optional().default(5),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("memory_recall", async ({ session_id, query, top_k }) => {
      const res = await chakudyaClient.post("/memory/recall", { session_id, query, top_k });
      return ok(res.data ?? res);
    })
  );

  // ── memory_write ─────────────────────────────────────────────────────────
  server.registerTool(
    "memory_write",
    {
      title: "Write Session Memory",
      description:
        "Write a raw memory fact tied to a session_id (e.g. a detail about a patient/case worth recalling " +
        "later in the same session). Written facts are periodically consolidated (hourly cron, or via " +
        "memory_consolidate) before they become searchable through memory_recall.",
      inputSchema: {
        session_id: z.string().min(1),
        content: z.string().min(1),
        kind: z.string().optional().default("fact"),
        patient_label: z.string().optional().describe("Optional label to scope the fact to a specific patient/case within the session"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    safeTool("memory_write", async ({ session_id, content, kind, patient_label }) => {
      const res = await chakudyaClient.post("/memory/write", { session_id, content, kind, patient_label });
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
        session_id: z.string().min(1),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("memory_consolidate", async ({ session_id }) => {
      const res = await chakudyaClient.post("/memory/consolidate", { session_id }, { useAdminKey: true });
      return ok(res.data ?? res);
    })
  );
}
