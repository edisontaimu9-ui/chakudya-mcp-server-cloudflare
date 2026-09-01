import { getEnv } from "../config/env.js";
import { logger } from "../utils/logger.js";

/**
 * Fetch-API equivalents of the Express requireAuth/rateLimit middleware from
 * the Render version. Same rules, same header/response shapes — just
 * `Request -> Response | null` instead of Express middleware signatures.
 * Returning `null` means "allowed, keep going"; returning a Response means
 * "reject with this".
 */

export function requireAuth(req: Request): Response | null {
  const env = getEnv();
  if (!env.MCP_AUTH_TOKEN) return null; // dev-only escape hatch, same as Render version

  const header = req.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);

  // Same fallback as the Render version: MCP clients whose UI only supports
  // OAuth and can't set a custom Authorization header can pass ?token=...
  const url = new URL(req.url);
  const queryToken = url.searchParams.get("token") ?? undefined;

  const token = match?.[1] ?? queryToken;

  if (!token || token !== env.MCP_AUTH_TOKEN) {
    logger.warn("mcp_auth_rejected", { path: url.pathname });

    const issuer = `${url.protocol}//${url.host}`;
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized: missing or invalid bearer token" },
        id: null,
      }),
      {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "WWW-Authenticate": `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource"`,
        },
      }
    );
  }

  return null;
}

/**
 * Minimal fixed-window per-IP rate limiter, same policy as the Render
 * version's in-memory limiter.
 *
 * IMPORTANT WORKERS CAVEAT (this has no Render equivalent): this `hits` Map
 * lives in the isolate's module scope, which Cloudflare may spin up fresh —
 * or run many of, across edge locations, under load — at any time. So this
 * limiter is best-effort per-isolate, not a global guarantee, in the same
 * way the Render version's comment already flags for a *multi-instance*
 * deployment. If you need a hard global cap, swap the Map below for a
 * Cloudflare KV or Durable Object counter keyed by IP.
 */
const hits = new Map<string, { count: number; resetAt: number }>();
const windowMs = 60_000;

export function rateLimit(req: Request): Response | null {
  const env = getEnv();
  // CF-Connecting-IP is Cloudflare's equivalent of Express's req.ip.
  const key = req.headers.get("cf-connecting-ip") ?? "unknown";
  const now = Date.now();
  const entry = hits.get(key);

  if (!entry || entry.resetAt < now) {
    hits.set(key, { count: 1, resetAt: now + windowMs });
    sweepExpired(now);
    return null;
  }

  entry.count += 1;
  if (entry.count > env.MCP_RATE_LIMIT_PER_MIN) {
    const retryAfterSec = Math.ceil((entry.resetAt - now) / 1000);
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32002, message: "Rate limit exceeded for this MCP server. Try again shortly." },
        id: null,
      }),
      {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": String(retryAfterSec) },
      }
    );
  }

  return null;
}

// No setInterval here (Workers doesn't run background timers between
// requests) — instead we sweep expired entries opportunistically whenever a
// fresh window starts, so the map still can't grow unbounded.
function sweepExpired(now: number) {
  if (hits.size < 1000) return; // only bother once it's actually grown
  for (const [key, entry] of hits) {
    if (entry.resetAt < now) hits.delete(key);
  }
}
