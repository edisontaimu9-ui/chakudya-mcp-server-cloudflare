import { ChakudyaApiError } from "../clients/chakudyaClient.js";
import { getEnv } from "../config/env.js";
import { logger } from "./logger.js";

/**
 * MCP tool handlers must never throw raw exceptions back through the SDK —
 * we catch everything and return a structured `isError` result instead, so
 * the calling model gets a clean, explainable message rather than a
 * transport-level failure.
 */

const DEFAULT_MAX_RESULT_CHARS = 30_000;

function maxChars(): number {
  try {
    return getEnv().MCP_MAX_RESULT_CHARS;
  } catch {
    return DEFAULT_MAX_RESULT_CHARS; // env not initialised (unit tests of pure helpers)
  }
}

const render = (payload: unknown) => JSON.stringify(payload, null, 2);

/**
 * Keeps one tool result from flooding the model's context. If the pretty-printed
 * JSON is over `limit` characters, the longest list in the result (the result
 * itself, or its largest top-level array field) is cut down to the number of
 * items that fits, and a `truncated` note says how many were kept. A result with
 * no list to cut (one giant string, say) is returned as a clearly flagged preview.
 * Results under the limit are returned untouched.
 */
export function capResult(data: unknown, meta: Record<string, unknown> | undefined, limit = maxChars()): string {
  const build = (d: unknown, extra?: Record<string, unknown>) => {
    const base = meta ? { ...meta, ...(extra ?? {}), data: d } : extra ? { ...extra, data: d } : d;
    return render(base);
  };

  const full = build(data);
  if (full.length <= limit) return full;

  // Find the list to shrink: the data itself, else its largest array field.
  let field: string | null = null;
  let list: unknown[] | null = null;
  if (Array.isArray(data)) {
    list = data;
  } else if (data && typeof data === "object") {
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      if (Array.isArray(v) && (!list || v.length > list.length)) {
        field = k;
        list = v;
      }
    }
  }

  const withKept = (n: number) => {
    const kept = (list as unknown[]).slice(0, n);
    return field === null ? kept : { ...(data as Record<string, unknown>), [field]: kept };
  };
  const note = (n: number) => ({
    truncated: {
      ...(field ? { field } : {}),
      returned: n,
      total: (list as unknown[]).length,
      note: "Result was too large and was cut to fit. Narrow the query or lower the limit to see more.",
    },
  });

  if (list && list.length > 1) {
    let lo = 0;
    let hi = list.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (build(withKept(mid), note(mid)).length <= limit) lo = mid;
      else hi = mid - 1;
    }
    return build(withKept(lo), note(lo));
  }

  // Nothing to drop item-by-item: return a flagged preview rather than a huge blob.
  return render({
    truncated: { note: "Result was too large and was cut to fit. Narrow the query to see more.", originalChars: full.length },
    preview: full.slice(0, Math.max(0, limit - 300)),
  });
}

export function ok(data: unknown, meta?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: capResult(data, meta) }],
  };
}

export function toolError(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const,
  };
}

/**
 * Wraps a tool handler body so any thrown error (from the Chakudya client,
 * a Zod refinement, or a bug) becomes a well-formed MCP error result instead
 * of crashing the request.
 */
export function safeTool<Args extends unknown[]>(
  name: string,
  fn: (...args: Args) => Promise<ReturnType<typeof ok>>
) {
  return async (...args: Args) => {
    try {
      return await fn(...args);
    } catch (e) {
      if (e instanceof ChakudyaApiError) {
        logger.warn("tool_chakudya_error", { tool: name, status: e.status, path: e.path });
        if (e.status === 404) {
          return toolError(`No matching data found. (${e.message})`);
        }
        if (e.status === 429) {
          return toolError(
            `The Chakudya API rate-limited this request. Please wait a moment and try again.`
          );
        }
        return toolError(`Chakudya API error (${e.status}): ${e.message}`);
      }
      logger.error("tool_unexpected_error", {
        tool: name,
        error: e instanceof Error ? e.message : String(e),
      });
      return toolError(
        `Unexpected error in tool "${name}": ${e instanceof Error ? e.message : String(e)}`
      );
    }
  };
}
