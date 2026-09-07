import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { chakudyaClient } from "../clients/chakudyaClient.js";
import { ok, safeTool } from "../utils/toolResult.js";

/**
 * Food logging (nutrition diary) against /log and /log/summary — distinct
 * from list_view_history in userDataTools.ts, which just tracks recently
 * *viewed* items. This is an actual per-meal calorie diary, keyed by the
 * same client-supplied user_id used everywhere else in Chakudya (favorites,
 * history — no server-side account system).
 *
 * Four tools:
 *   - log_food_entry
 *   - list_food_log
 *   - delete_food_log_entry
 *   - get_food_log_summary
 */

const MEAL_TYPE = z.enum(["breakfast", "lunch", "snack", "dinner"]);
const DATE_STRING = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be in YYYY-MM-DD format");

export function registerFoodLogTools(server: McpServer) {
  // ── log_food_entry ───────────────────────────────────────────────────────
  server.registerTool(
    "log_food_entry",
    {
      title: "Log a Food Diary Entry",
      description:
        "Log a meal/snack entry (calories, meal type, optional food name) to a user's nutrition diary for " +
        "a given date (defaults to today server-side if entry_date is omitted).",
      inputSchema: {
        user_id: z.string().min(1),
        meal_type: MEAL_TYPE,
        calories: z.number().nonnegative(),
        food_name: z.string().optional(),
        entry_date: DATE_STRING.optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    safeTool("log_food_entry", async ({ user_id, meal_type, calories, food_name, entry_date }) => {
      const res = await chakudyaClient.post("/log", {
        user_id,
        meal_type,
        calories,
        food_name,
        entry_date,
      });
      return ok(res.data ?? res);
    })
  );

  // ── list_food_log ────────────────────────────────────────────────────────
  server.registerTool(
    "list_food_log",
    {
      title: "List Food Diary Entries",
      description:
        "List a user's nutrition diary entries, most recent first. Optionally filter to a single date " +
        "(YYYY-MM-DD).",
      inputSchema: {
        user_id: z.string().min(1),
        date: DATE_STRING.optional(),
        limit: z.number().int().positive().max(100).optional().default(50),
        offset: z.number().int().nonnegative().optional().default(0),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("list_food_log", async ({ user_id, date, limit, offset }) => {
      const res = await chakudyaClient.get("/log", { user_id, date, limit, offset });
      return ok(res.data ?? res);
    })
  );

  // ── delete_food_log_entry ────────────────────────────────────────────────
  server.registerTool(
    "delete_food_log_entry",
    {
      title: "Delete a Food Diary Entry",
      description: "Delete one nutrition diary entry by id. The owning user_id must match.",
      inputSchema: {
        entry_id: z.union([z.string(), z.number()]),
        user_id: z.string().min(1),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    safeTool("delete_food_log_entry", async ({ entry_id, user_id }) => {
      const res = await chakudyaClient.del(`/log/${entry_id}`, undefined, { params: { user_id } });
      return ok(res.data ?? { message: (res as { message?: unknown }).message ?? "Deleted" });
    })
  );

  // ── get_food_log_summary ─────────────────────────────────────────────────
  server.registerTool(
    "get_food_log_summary",
    {
      title: "Get Food Diary Summary",
      description:
        "Aggregate a user's nutrition diary into calorie totals. 'daily' (default) gives one day's " +
        "breakdown by meal type; 'weekly' gives a 7-day window ending on 'date' (default today) with " +
        "per-day totals, a per-meal breakdown across the whole week, and the daily average.",
      inputSchema: {
        user_id: z.string().min(1),
        period: z.enum(["daily", "weekly"]).optional().default("daily"),
        date: DATE_STRING.optional().describe("Anchor/end date, defaults to today"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("get_food_log_summary", async ({ user_id, period, date }) => {
      const res = await chakudyaClient.get("/log/summary", { user_id, period, date });
      return ok(res.data ?? res);
    })
  );
}
