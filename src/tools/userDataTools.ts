import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { chakudyaClient } from "../clients/chakudyaClient.js";
import { ok, safeTool } from "../utils/toolResult.js";

/**
 * Per-user favorites and recently-viewed history against the Chakudya API's
 * /favorites and /history routes. There is no server-side account system —
 * user_id is a client-supplied identifier (e.g. a device id or session id),
 * consistent with how the rest of Chakudya identifies a "user".
 *
 * Five tools:
 *   - list_favorites
 *   - save_favorite
 *   - remove_favorite
 *   - list_view_history
 *   - log_view
 */

const RESOURCE_TYPE = z.enum(["food", "packaged"]);

export function registerUserDataTools(server: McpServer) {
  // ── list_favorites ─────────────────────────────────────────────────────
  server.registerTool(
    "list_favorites",
    {
      title: "List a User's Favorites",
      description:
        "List the foods/packaged products a given user_id has favorited, most-relevant pagination via " +
        "limit/offset (or cursor-based if a cursor is supplied).",
      inputSchema: {
        user_id: z.string().min(1).describe("Client-supplied user/device identifier"),
        resource_type: RESOURCE_TYPE.optional(),
        limit: z.number().int().positive().max(100).optional().default(50),
        offset: z.number().int().nonnegative().optional().default(0),
        cursor: z.string().optional().describe("Switches to keyset pagination when present, even empty string"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("list_favorites", async ({ user_id, resource_type, limit, offset, cursor }) => {
      const res = await chakudyaClient.get("/favorites", {
        user_id,
        resource_type,
        limit,
        offset,
        cursor,
      });
      return ok(res.data ?? res);
    })
  );

  // ── save_favorite ────────────────────────────────────────────────────────
  server.registerTool(
    "save_favorite",
    {
      title: "Save a Favorite",
      description:
        "Save a food or packaged product as a favorite for a given user_id. Idempotent — saving the same " +
        "(user_id, resource_type, resource_id) again is a no-op rather than a duplicate.",
      inputSchema: {
        user_id: z.string().min(1),
        resource_type: RESOURCE_TYPE,
        resource_id: z.number().int(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("save_favorite", async ({ user_id, resource_type, resource_id }) => {
      const res = await chakudyaClient.post("/favorites", { user_id, resource_type, resource_id });
      return ok(res.data ?? res);
    })
  );

  // ── remove_favorite ──────────────────────────────────────────────────────
  server.registerTool(
    "remove_favorite",
    {
      title: "Remove a Favorite",
      description:
        "Remove a previously saved favorite for a given user_id. No error if it doesn't exist — the " +
        "response includes removed:false in that case instead.",
      inputSchema: {
        user_id: z.string().min(1),
        resource_type: RESOURCE_TYPE,
        resource_id: z.number().int(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    safeTool("remove_favorite", async ({ user_id, resource_type, resource_id }) => {
      const res = await chakudyaClient.del("/favorites", { user_id, resource_type, resource_id });
      return ok(res.data ?? res);
    })
  );

  // ── list_view_history ────────────────────────────────────────────────────
  server.registerTool(
    "list_view_history",
    {
      title: "List a User's Recently Viewed Items",
      description:
        "List a given user_id's recently viewed foods/packaged products, most recent first. Nothing is " +
        "tracked automatically — items only appear here after an explicit log_view call.",
      inputSchema: {
        user_id: z.string().min(1),
        resource_type: RESOURCE_TYPE.optional(),
        limit: z.number().int().positive().max(100).optional().default(50),
        offset: z.number().int().nonnegative().optional().default(0),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("list_view_history", async ({ user_id, resource_type, limit, offset }) => {
      const res = await chakudyaClient.get("/history", { user_id, resource_type, limit, offset });
      return ok(res.data ?? res);
    })
  );

  // ── log_view ─────────────────────────────────────────────────────────────
  server.registerTool(
    "log_view",
    {
      title: "Log a Viewed Item",
      description:
        "Record that a user_id viewed a specific food/packaged product, for later retrieval via " +
        "list_view_history. Upserts on (user_id, resource_type, resource_id) — repeat views update the " +
        "viewed_at timestamp in place rather than creating duplicate rows. Opt-in only; call this " +
        "explicitly when you want a view remembered.",
      inputSchema: {
        user_id: z.string().min(1),
        resource_type: RESOURCE_TYPE,
        resource_id: z.number().int(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("log_view", async ({ user_id, resource_type, resource_id }) => {
      const res = await chakudyaClient.post("/history", { user_id, resource_type, resource_id });
      return ok(res.data ?? res);
    })
  );
}
