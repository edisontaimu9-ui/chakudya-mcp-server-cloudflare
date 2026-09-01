import { getEnv } from "../config/env.js";
import { logger } from "../utils/logger.js";

/**
 * Fetch-API port of the Render version's Express oauthRouter. Same minimum
 * OAuth 2.1 + PKCE surface, auto-approving every request (there's still only
 * one real credential: MCP_AUTH_TOKEN) — see the Render version's oauth.ts
 * for the full rationale. This file only changes *how* it's wired (fetch
 * routing + Web Crypto instead of Express + node:crypto); the protocol
 * behavior is identical.
 *
 * Endpoints:
 *   GET  /.well-known/oauth-authorization-server
 *   GET  /.well-known/oauth-protected-resource
 *   POST /register
 *   GET  /authorize
 *   POST /token
 *
 * handleOAuthRoute returns `null` if the request doesn't match any of these,
 * so index.ts can fall through to the rest of its routing.
 */

interface PendingCode {
  codeChallenge: string;
  redirectUri: string;
  expiresAt: number;
}
// Same in-memory-only tradeoff as security.ts's rate limiter: fine because
// codes live for ~60s, and worst case a code lands on a different isolate
// and the flow just fails cleanly, forcing the client to retry /authorize.
const pendingCodes = new Map<string, PendingCode>();

function issuerFrom(url: URL): string {
  return `${url.protocol}//${url.host}`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function sha256Base64Url(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function verifyPkce(verifier: string, challenge: string): Promise<boolean> {
  return (await sha256Base64Url(verifier)) === challenge;
}

export async function handleOAuthRoute(req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  const issuer = issuerFrom(url);

  if (req.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
    return json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      registration_endpoint: `${issuer}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["mcp"],
    });
  }

  if (req.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource") {
    return json({
      resource: `${issuer}/mcp`,
      authorization_servers: [issuer],
      bearer_methods_supported: ["header"],
    });
  }

  if (req.method === "POST" && url.pathname === "/register") {
    const body = await req.json().catch(() => ({}) as Record<string, unknown>);
    const clientId = crypto.randomUUID();
    logger.info("oauth_client_registered", { clientId });
    return json(
      {
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        redirect_uris: (body as { redirect_uris?: unknown }).redirect_uris ?? [],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      201
    );
  }

  if (req.method === "GET" && url.pathname === "/authorize") {
    const redirectUri = url.searchParams.get("redirect_uri");
    const state = url.searchParams.get("state");
    const codeChallenge = url.searchParams.get("code_challenge");
    const codeChallengeMethod = url.searchParams.get("code_challenge_method");

    if (!redirectUri) return new Response("Missing redirect_uri", { status: 400 });
    if (!codeChallenge || codeChallengeMethod !== "S256") {
      return new Response("This server requires PKCE with S256.", { status: 400 });
    }

    const code = crypto.randomUUID();
    pendingCodes.set(code, { codeChallenge, redirectUri, expiresAt: Date.now() + 60_000 });

    const redirect = new URL(redirectUri);
    redirect.searchParams.set("code", code);
    if (state) redirect.searchParams.set("state", state);

    logger.info("oauth_authorize_auto_approved", { redirectUri });
    return Response.redirect(redirect.toString(), 302);
  }

  if (req.method === "POST" && url.pathname === "/token") {
    const env = getEnv();
    const contentType = req.headers.get("content-type") ?? "";
    let body: Record<string, unknown>;
    if (contentType.includes("application/json")) {
      body = await req.json().catch(() => ({}));
    } else {
      // RFC 6749 form-encoded body — same dual handling as the Render version.
      const form = await req.formData().catch(() => new FormData());
      body = Object.fromEntries(form.entries());
    }

    const grantType = body.grant_type as string | undefined;

    if (grantType === "authorization_code") {
      const code = body.code as string | undefined;
      const verifier = body.code_verifier as string | undefined;
      const pending = code ? pendingCodes.get(code) : undefined;

      if (!code || !pending) {
        return json({ error: "invalid_grant", error_description: "Unknown or expired code" }, 400);
      }
      pendingCodes.delete(code); // one-time use

      if (pending.expiresAt < Date.now()) {
        return json({ error: "invalid_grant", error_description: "Code expired" }, 400);
      }
      if (!verifier || !(await verifyPkce(verifier, pending.codeChallenge))) {
        return json({ error: "invalid_grant", error_description: "PKCE verification failed" }, 400);
      }

      logger.info("oauth_token_issued", { grantType });
      return json({
        access_token: env.MCP_AUTH_TOKEN,
        token_type: "Bearer",
        expires_in: 31536000,
        refresh_token: env.MCP_AUTH_TOKEN,
        scope: "mcp",
      });
    }

    if (grantType === "refresh_token") {
      logger.info("oauth_token_refreshed", { grantType });
      return json({
        access_token: env.MCP_AUTH_TOKEN,
        token_type: "Bearer",
        expires_in: 31536000,
        refresh_token: env.MCP_AUTH_TOKEN,
        scope: "mcp",
      });
    }

    return json({ error: "unsupported_grant_type" }, 400);
  }

  return null; // not an OAuth route — let index.ts keep routing
}
