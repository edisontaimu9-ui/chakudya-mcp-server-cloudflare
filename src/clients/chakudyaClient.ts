import { getEnv, getChakudyaApiBinding } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { TtlCache } from "../utils/ttlCache.js";

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

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const MAX_RETRY_WAIT_MS = 2_000;

/** Base delay between attempts. Exposed only so tests can shorten it. */
let retryBaseMs = 250;
export function __setRetryBaseMsForTests(ms: number) {
  retryBaseMs = ms;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Exponential backoff with a little jitter, capped so a retry never stalls a tool call. */
function backoffMs(attempt: number): number {
  const base = retryBaseMs * 2 ** attempt;
  return Math.min(MAX_RETRY_WAIT_MS, base + Math.floor(Math.random() * (retryBaseMs / 2 + 1)));
}

/** Honours a numeric Retry-After header on 429, capped at MAX_RETRY_WAIT_MS. */
function retryAfterMs(res: Response): number | null {
  const v = Number(res.headers.get("retry-after"));
  return Number.isFinite(v) && v > 0 ? Math.min(MAX_RETRY_WAIT_MS, v * 1000) : null;
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

// ── Cache for stable reference lookups ─────────────────────────────────────────
// Only GETs of data that rarely changes are cached: the category list and single
// foods by id (and their labels). Searches, logs, memory, RAG and anything sent
// with the admin key are never cached. Errors are never cached. The cache is
// per isolate (see TtlCache), keyed by path plus sorted query string.
const resultCache = new TtlCache<unknown>(300);
const CATEGORIES_TTL_MS = 24 * 60 * 60 * 1000;
const NON_ID_FOOD_ROUTES = new Set(["categories", "search", "lookup", "autocomplete", "convert", "compare"]);

/** Returns the cache lifetime for a GET path, or 0 if it must not be cached. */
export function cacheTtlMs(path: string): number {
  let ttlSeconds: number;
  try {
    ttlSeconds = getEnv().MCP_CACHE_TTL_SECONDS;
  } catch {
    return 0;
  }
  if (ttlSeconds <= 0) return 0;
  if (path === "/foods/categories") return CATEGORIES_TTL_MS;
  const m = path.match(/^\/foods\/([^/]+)(\/label)?$/);
  if (m && !NON_ID_FOOD_ROUTES.has(m[1])) return ttlSeconds * 1000;
  return 0;
}

function cacheKey(path: string, params?: Record<string, string | number | boolean | undefined>): string {
  const q = Object.entries(params ?? {})
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${String(v)}`)
    .sort()
    .join("&");
  return q ? `${path}?${q}` : path;
}

/** Empties the lookup cache. Used by tests. */
export function __clearCacheForTests(): void {
  resultCache.clear();
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
    /** Extra attempts after the first, GET only. Default 1. */
    retries?: number;
  } = {}
): Promise<CnrEnvelope<T>> {
  const ttl = method === "GET" && !opts.useAdminKey ? cacheTtlMs(path) : 0;
  const key = ttl > 0 ? cacheKey(path, opts.params) : "";
  if (ttl > 0) {
    const hit = resultCache.get(key);
    if (hit !== undefined) {
      logger.debug("chakudya_cache_hit", { path });
      return structuredClone(hit) as CnrEnvelope<T>; // a copy, so a caller can't alter the cached entry
    }
  }
  const { text } = await rawRequest(method, path, opts);

  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON response body; fall through with an empty envelope. Routes
    // that don't return JSON (e.g. GET /fenton-preterm/chart, image/svg+xml)
    // must use chakudyaClient.getRaw() instead of get(), not this function.
  }

  // rawRequest throws on any non-2xx, so only successful answers reach here.
  if (ttl > 0 && parsed !== null) resultCache.set(key, structuredClone(parsed), ttl); // a copy: the caller keeps `parsed`
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
    /** Extra attempts after the first, GET only. Default 1. */
    retries?: number;
  } = {}
): Promise<{ res: Response; text: string; contentType: string }> {
  const { params, body, useAdminKey, timeoutMs = 15_000 } = opts;
  const url = buildUrl(path, params);

  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  // chakudya-api refuses every data route without an API key, so every call carries one.
  // Admin-gated routes (registry writes, the packaged review queue, RAG ingest, memory
  // consolidation) use CHAKUDYA_ADMIN_API_KEY; everything else uses the consumer key
  // CHAKUDYA_API_KEY. A consumer key is refused on admin routes, and an admin key also
  // works everywhere, but keeping them apart means a leaked consumer key can only read.
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
  } else {
    const apiKey = getEnv().CHAKUDYA_API_KEY;
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    } else {
      logger.warn("chakudya_api_key_missing", { path });
    }
  }

  // Only idempotent GETs are retried: a repeated POST/DELETE could write twice.
  // One retry covers the usual blip (a cold Worker, a brief upstream 502/503/504,
  // a 429) without stacking 15 s timeouts. A timeout is NOT retried, since the
  // caller has already waited the full timeoutMs once.
  const maxRetries = method === "GET" ? Math.max(0, opts.retries ?? 1) : 0;

  for (let attempt = 0; ; attempt++) {
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
      if (!isAbort && attempt < maxRetries) {
        logger.warn("chakudya_api_retry", { path, attempt: attempt + 1, reason: "network_error" });
        await sleep(backoffMs(attempt));
        continue;
      }
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

    if (RETRYABLE_STATUS.has(res.status) && attempt < maxRetries) {
      logger.warn("chakudya_api_retry", { path, attempt: attempt + 1, reason: `http_${res.status}` });
      const wait = res.status === 429 ? retryAfterMs(res) ?? backoffMs(attempt) : backoffMs(attempt);
      await res.body?.cancel().catch(() => {});
      await sleep(wait);
      continue;
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
