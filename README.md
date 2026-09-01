# Chakudya MCP Server — Cloudflare Workers edition

This is the **Cloudflare Workers** deployment of the Chakudya MCP server. It
exposes the same 11 tool groups over the same MCP Streamable HTTP protocol,
calling the same Chakudya Nutrition Registry (CNR) API, as the existing
**Render/Express** deployment (`chakudya-mcp-server` repo). The two are
independent services that can run side by side — this one is not a
replacement, it's a second front door to the same tools.

## What's different from the Render version

Only the hosting-layer plumbing — nothing about the tools or the CNR API
they call:

| | Render version | This (Cloudflare) version |
|---|---|---|
| Runtime | Node.js + Express | Cloudflare Workers (`fetch` handler) |
| MCP transport | SDK's `StreamableHTTPServerTransport`, stateful, session map | Custom stateless one-request-one-response transport (`src/server/mcpTransport.ts`) — see that file for why |
| Config | `process.env` / `.env` via dotenv | `wrangler.jsonc` vars + `wrangler secret put` |
| Crypto (OAuth PKCE) | `node:crypto` | Web Crypto (`crypto.subtle`, `crypto.randomUUID()`) |
| GET/DELETE `/mcp` (SSE stream, session teardown) | Supported | Not supported (405) — no standing session in stateless mode |

Everything else — `src/tools/*`, `src/utils/toolResult.ts`, the WHO growth
data, `src/server/createServer.ts` — is byte-for-byte identical to the
Render version, copied straight across.

## Setup

```bash
npm install
```

## Local dev

```bash
cp .dev.vars.example .dev.vars   # fill in a dev MCP_AUTH_TOKEN
npm run dev
```

## Deploy

```bash
npx wrangler secret put MCP_AUTH_TOKEN
# optional, only if you use admin-gated CNR routes:
npx wrangler secret put CHAKUDYA_ADMIN_API_KEY

npm run deploy
```

Non-secret config (`CHAKUDYA_API_BASE_URL`, `MCP_ALLOWED_ORIGINS`,
`MCP_RATE_LIMIT_PER_MIN`) is set in `wrangler.jsonc` under `vars` — edit that
file directly rather than using `wrangler secret put` for those.

## Connecting an MCP client

Same as the Render deployment: point the client at
`https://<your-worker-subdomain>.workers.dev/mcp` with
`Authorization: Bearer <MCP_AUTH_TOKEN>`, or use the OAuth flow
(`/.well-known/oauth-authorization-server`) for clients like Claude.ai's
custom connector UI that don't support raw bearer tokens.

## Health check

`GET /health` → `{"status":"ok","service":"chakudya-mcp-server-cloudflare",...}`
