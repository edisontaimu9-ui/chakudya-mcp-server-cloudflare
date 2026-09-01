import { getEnv } from "../config/env.js";
import { logger } from "../utils/logger.js";

/**
 * Fetch-API port of the Render version's Express oauthRouter — same
 * minimum OAuth 2.1 + PKCE surface, auto-approving every request (there's
 * still only one real credential: MCP_AUTH_TOKEN).
 *
 * IMPORTANT DIFFERENCE FROM THE RENDER VERSION: Render runs one persistent
 * Node process, so an in-memory `Map` of pending authorization codes works
 * fine — the same process handles both /authorize and /token. Cloudflare
 * Workers has no such guarantee: /authorize and /token can land on two
 * different isolates at two different edge locations, so a `Map` written
 * on isolate A is invisible to isolate B. That mismatch was causing every
 * connector setup to fail with "Unknown or expired code."
 *
 * Fix: the authorization code is now self-contained and stateless. It
 * carries its own payload (code_challenge, redirect_uri, expiry) plus an
 * HMAC-SHA256 signature keyed on MCP_AUTH_TOKEN. /token verifies the
 * signature and expiry directly from the code itself — no shared memory
 * needed, so it works no matter which isolate handles which request.
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

interface CodePayload {
  codeChallenge: string;
  redirectUri: string;
  expiresAt: number;
}

function issuerFrom(url: URL): string {
  return `${url.protocol}//${url.host}`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return toBase64Url(new Uint8Array(digest));
}

async function verifyPkce(verifier: string, challenge: string): Promise<boolean> {
  return (await sha256Base64Url(verifier)) === challenge;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

/** Packs a CodePayload into a signed, URL-safe authorization code. */
async function signCode(payload: CodePayload, secret: string): Promise<string> {
  const body = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `${body}.${toBase64Url(new Uint8Array(sig))}`;
}

/** Verifies and unpacks a signed authorization code. Returns null if invalid, tampered, or expired. */
async function verifyCode(code: string, secret: string): Promise<CodePayload | null> {
  const [body, sig] = code.split(".");
  if (!body || !sig) return null;

  const key = await hmacKey(secret);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    fromBase64Url(sig),
    new TextEncoder().encode(body)
  );
  if (!valid) return null;

  try {
    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(body))) as CodePayload;
    if (payload.expiresAt < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
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
    const env = getEnv();
    const redirectUri = url.searchParams.get("redirect_uri");
    const state = url.searchParams.get("state");
    const codeChallenge = url.searchParams.get("code_challenge");
    const codeChallengeMethod = url.searchParams.get("code_challenge_method");

    if (!redirectUri) return new Response("Missing redirect_uri", { status: 400 });
    if (!codeChallenge || codeChallengeMethod !== "S256") {
      return new Response("This server requires PKCE with S256.", { status: 400 });
    }
    if (!env.MCP_AUTH_TOKEN) {
      return new Response("Server misconfigured: MCP_AUTH_TOKEN not set.", { status: 500 });
    }

    const code = await signCode(
      { codeChallenge, redirectUri, expiresAt: Date.now() + 60_000 },
      env.MCP_AUTH_TOKEN
    );

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
      if (!env.MCP_AUTH_TOKEN) {
        return json({ error: "server_error", error_description: "Server misconfigured" }, 500);
      }

      const code = body.code as string | undefined;
      const verifier = body.code_verifier as string | undefined;
      const payload = code ? await verifyCode(code, env.MCP_AUTH_TOKEN) : null;

      if (!code || !payload) {
        return json({ error: "invalid_grant", error_description: "Unknown, expired, or tampered code" }, 400);
      }
      if (!verifier || !(await verifyPkce(verifier, payload.codeChallenge))) {
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
