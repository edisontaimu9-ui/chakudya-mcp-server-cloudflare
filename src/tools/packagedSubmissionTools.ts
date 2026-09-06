import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { chakudyaClient } from "../clients/chakudyaClient.js";
import { ok, safeTool } from "../utils/toolResult.js";

/**
 * Community submission and admin moderation for packaged/branded products
 * not yet in the Chakudya database — complements the read-side
 * barcode_lookup/packaged_food_search tools in foodTools.ts.
 *
 * Three tools:
 *   - submit_packaged_food
 *   - submit_packaged_food_photo
 *   - list_pending_packaged_foods (admin)
 */

export function registerPackagedSubmissionTools(server: McpServer) {
  // ── submit_packaged_food ─────────────────────────────────────────────────
  server.registerTool(
    "submit_packaged_food",
    {
      title: "Submit a Packaged Food (Manual)",
      description:
        "Submit a new packaged/branded product by barcode and name, with optional nutrition fields. " +
        "Auto-tagged status=pending for review. Returns 409-derived data (already_exists:true) instead of " +
        "erroring if an approved/pending row already has this barcode. A rejected prior submission for the " +
        "same barcode is overwritten in place. Additional nutrition fields beyond barcode/product_name/per/" +
        "serving_size can be passed and will be forwarded as-is.",
      inputSchema: {
        barcode: z.string().min(1),
        product_name: z.string().min(1),
        per: z.enum(["100g", "100ml", "serving"]).optional(),
        serving_size: z.string().optional().describe("e.g. '30g'"),
        extra_fields: z
          .record(z.unknown())
          .optional()
          .describe("Any additional nutrition fields to include (e.g. energy_kcal, protein_g, fat_g, carbs_g)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    safeTool("submit_packaged_food", async ({ barcode, product_name, per, serving_size, extra_fields }) => {
      const res = await chakudyaClient.post("/packaged/submit", {
        barcode,
        product_name,
        per,
        serving_size,
        ...extra_fields,
      });
      return ok(res.data ?? res, {
        already_exists: (res as { already_exists?: boolean }).already_exists ?? false,
      });
    })
  );

  // ── submit_packaged_food_photo ───────────────────────────────────────────
  server.registerTool(
    "submit_packaged_food_photo",
    {
      title: "Submit a Packaged Food via Photo (Vision OCR)",
      description:
        "Submit a new packaged product from 1-5 photos of its nutrition label. The Chakudya API sends the " +
        "photos to a vision model, combines what it reads across all of them, and inserts a pending row " +
        "(source=ocr_ai). Fails with a needs_retry result (nothing written) if no photo shows a legible " +
        "nutrition label. Same duplicate-detection behavior as submit_packaged_food. Each image must be a " +
        "data:image/...;base64,... URL or bare base64 (assumed JPEG).",
      inputSchema: {
        images: z.array(z.string().min(1)).min(1).max(5),
        barcode: z.string().optional().describe("Optional — takes priority over anything the vision model reads."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    safeTool("submit_packaged_food_photo", async ({ images, barcode }) => {
      const res = await chakudyaClient.post("/packaged/scan", { images, barcode });
      return ok(res.data ?? res);
    })
  );

  // ── list_pending_packaged_foods ──────────────────────────────────────────
  server.registerTool(
    "list_pending_packaged_foods",
    {
      title: "List Pending Packaged Food Submissions (Admin)",
      description:
        "Admin review queue: packaged food rows with status=pending from either submission path (manual or " +
        "ocr_ai), oldest first. Requires CHAKUDYA_ADMIN_API_KEY to be configured on this MCP server.",
      inputSchema: {
        source: z.enum(["manual", "ocr_ai"]).optional(),
        limit: z.number().int().positive().max(100).optional().default(50),
        offset: z.number().int().nonnegative().optional().default(0),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safeTool("list_pending_packaged_foods", async ({ source, limit, offset }) => {
      const res = await chakudyaClient.get("/packaged/pending", { source, limit, offset }, { useAdminKey: true });
      return ok(res.data ?? res);
    })
  );
}
