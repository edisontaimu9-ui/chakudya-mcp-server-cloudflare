import { ok } from "./toolResult.js";

/**
 * Condition-specific API answers carry their `disclaimer` and `citation` inside the data object.
 * Tools return them beside the data (`{ disclaimer, citation, data }`), the shape these tools have
 * always had, so callers that read the disclaimer keep working.
 */
export function okWithApiMeta(res: unknown) {
  const payload = (res as { data?: unknown } | null)?.data ?? res;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const { disclaimer, citation, ...rest } = payload as Record<string, unknown>;
    if (disclaimer !== undefined || citation !== undefined) return ok(rest, { disclaimer, citation });
  }
  return ok(payload);
}
