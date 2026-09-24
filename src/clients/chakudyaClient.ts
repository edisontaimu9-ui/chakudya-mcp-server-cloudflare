import { getEnv, getChakudyaApiBinding } from "../config/env.js";
import { logger } from "../utils/logger.js";

/**
 * Thin HTTP client for the already-deployed Chakudya Nutrition Registry
 * Worker (chakudya-api). This file intentionally contains NO business logic
 * of its own — it only knows how to call the existing API and normalize
 * errors. All Chakudya-specific behavior (routes, query params, auth model)
 * lives in the Worker itself; this client just mirrors it.
 */

export class ChakudyaApiError extends Error {
  readonly status: number;
  readonly path: string;
  readonly body: unknown;

  constructor(message: string, status: number, path: string, body: unknown) {
    super(message);
    this.name = "ChakudyaApiError";
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

interface CnrEnvelope<T = unknown> {
  status: "success" | "error" | "not_found";
  message?: string;
  count?: number;
  limit?: number;
  offset?: number;
  data?: T;
  [key: string]: unknown;
}

function buildUrl(path: string, params?: Record<string, string | number | boolean | undefined>) {
  const baseUrl = getEnv().CHAKUDYA_API_BASE_URL.replace(/\/$/, "");
  const url = new URL(baseUrl + path);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === "") continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url;
}

async function request<T = unknown>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  opts: {
    params?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
    /** Set true only for routes documented as admin-gated in the CNR README. */
    useAdminKey?: boolean;
    timeoutMs?: number;
  } = {}
): Promise<CnrEnvelope<T>> {
  const { text } = await rawRequest(method, path, opts);

  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON response body; fall through with an empty envelope. Routes
    // that don't return JSON (e.g. GET /fenton-preterm/chart, image/svg+xml)
    // must use chakudyaClient.getRaw() instead of get(), not this function.
  }

  return (parsed ?? {}) as CnrEnvelope<T>;
}

/**
 * Shared fetch logic (binding preference, timeout, error normalization) for
 * both the JSON-parsing `request()` above and `getRaw()` below, which some
 * routes need because they don't return a CNR JSON envelope at all (e.g.
 * GET /fenton-preterm/chart returns image/svg+xml).
 */
async function rawRequest(
  method: "GET" | "POST" | "DELETE",
  path: string,
  opts: {
    params?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
    useAdminKey?: boolean;
    timeoutMs?: number;
  } = {}
): Promise<{ res: Response; text: string; contentType: string }> {
  const { params, body, useAdminKey, timeoutMs = 15_000 } = opts;
  const url = buildUrl(path, params);

  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (useAdminKey) {
    const adminKey = getEnv().CHAKUDYA_ADMIN_API_KEY;
    if (!adminKey) {
      throw new ChakudyaApiError(
        "This operation requires CHAKUDYA_ADMIN_API_KEY to be set on the MCP server, but it isn't.",
        500,
        path,
        null
      );
    }
    headers.Authorization = `Bearer ${adminKey}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    // Prefer the service binding — a direct Worker-to-Worker call at the
    // platform level. A plain fetch() to chakudya-api's public *.workers.dev
    // URL reliably 404s when made FROM another Worker on the same Cloudflare
    // account (a documented Cloudflare platform limitation, confirmed via
    // curl-vs-Worker testing on 2026-09-02 — curl to the exact same URL
    // returns 200). The binding sidesteps that entirely and is faster too,
    // since it skips the public network hop. Falls back to plain fetch()
    // if the binding is ever unset (e.g. local `wrangler dev` without
    // --remote) so this client still works in that case.
    const binding = getChakudyaApiBinding();
    const fetchInit: RequestInit = {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    };
    res = binding
      ? await binding.fetch(url.toString(), fetchInit)
      : await fetch(url.toString(), fetchInit);
  } catch (e) {
    clearTimeout(timer);
    const isAbort = e instanceof Error && e.name === "AbortError";
    throw new ChakudyaApiError(
      isAbort
        ? `Chakudya API request timed out after ${timeoutMs}ms`
        : `Network error calling Chakudya API: ${(e as Error).message}`,
      isAbort ? 504 : 502,
      path,
      null
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  const contentType = res.headers.get("content-type") ?? "";

  if (!res.ok) {
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // error body wasn't JSON either (unlikely for this API); fall through
    }
    const message =
      (parsed as CnrEnvelope | null)?.message ?? `Chakudya API returned HTTP ${res.status} for ${method} ${path}`;
    logger.warn("chakudya_api_error", { path, status: res.status, message });
    throw new ChakudyaApiError(message, res.status, path, parsed ?? text);
  }

  return { res, text, contentType };
}


export const chakudyaClient = {
  get: <T = unknown>(
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
    opts: { useAdminKey?: boolean } = {}
  ) => request<T>("GET", path, { params, useAdminKey: opts.useAdminKey }),

  /**
   * For routes that don't return a CNR JSON envelope — currently only
   * GET /fenton-preterm/chart (image/svg+xml). Returns the raw response
   * text and its content-type; does NOT attempt JSON.parse.
   */
  getRaw: (path: string, params?: Record<string, string | number | boolean | undefined>) =>
    rawRequest("GET", path, { params }).then(({ text, contentType }) => ({ text, contentType })),

  post: <T = unknown>(path: string, body: unknown, opts: { useAdminKey?: boolean } = {}) =>
    request<T>("POST", path, { body, useAdminKey: opts.useAdminKey }),

  // Named `del`, not `delete` — `delete` is a reserved word as an object
  // property accessor style method name in some lint configs and reads
  // oddly as `chakudyaClient.delete(...)`; `del` mirrors common HTTP client
  // conventions (e.g. node-fetch wrappers, superagent).
  //
  // Chakudya's own DELETE routes aren't consistent about where identifying
  // info goes: DELETE /favorites takes a JSON body (no id in the path),
  // while DELETE /log/:id takes the id in the path plus ?user_id= as a
  // query param with no body at all. Support both via params + body so
  // callers don't have to work around a body-only client.
  del: <T = unknown>(
    path: string,
    body?: unknown,
    opts: { useAdminKey?: boolean; params?: Record<string, string | number | boolean | undefined> } = {}
  ) => request<T>("DELETE", path, { body, params: opts.params, useAdminKey: opts.useAdminKey }),
};
