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

## Malnutrition screening tools (by population)

Each population has one orchestration tool that takes the person's details
once, classifies deterministically, and returns a recommended action. The AI
layer calling them must treat the output as authoritative.

| Population | Tool | What it combines |
|---|---|---|
| 0–59 months | `under5_integrated_screen` | WHO growth z-scores, NACS (oedema, MUAC, WHZ), optional STRONGkids/PNST/PYMS/STAMP |
| 5–17 years | `school_age_integrated_screen` | BMI-for-age (WHO 2007, see below), NACS age-banded MUAC + oedema, optional STRONGkids |
| Adults 18+ (not pregnant/postpartum) | `adult_integrated_screen` | NACS (oedema, MUAC, BMI from weight+height, confirmed >10% weight loss), optional MUST on a separate axis |
| Pregnant / postpartum women | `pregnant_postpartum_integrated_screen` | NACS maternal cut-offs |

Supporting tools: `bmi_for_age_classify` (thin wrapper over the Chakudya API's
`/bmi-for-age/classify`, 5y 1m – 19y 0m), `must_screen` (BAPEN MUST score),
`nacs_classify_*`, `who_growth_zscore`.

**BMI-for-age and the Chakudya API.** `school_age_integrated_screen` and
`bmi_for_age_classify` call `GET /bmi-for-age/classify` on the Chakudya API
(WHO 2007 table as printed in Malawi MoH *Eat Well to Live Well*, 2021, Annex 2)
through the same `CHAKUDYA_API` binding / base URL as the other tools. If that
call fails, the screening tool falls back to the in-process WHO 2007 LMS
calculation and says so in `limitations`; if the two ever disagree it uses the
API result and raises a `bmi_for_age_source_disagreement` flag.

**Height that can't be measured standing.** `adult_integrated_screen` accepts
`ulna_length_cm` (18.5–32.0 cm) or `knee_height_cm` + `race` when `height_cm`
is missing, and estimates height with the same functions as
`stature_from_ulna_length` / `stature_from_knee_height` (ulna is tried first).
A measured height always wins. The output labels the height as estimated
(`measurements.height_source`, a `bmi_from_estimated_height` flag, limitations),
shows the BMI range implied by the knee-height equation's published error, and
flags `bmi_classification_uncertain` when that range crosses a NACS cut-off.
One ulna-table cell (men 65+, 30.0 cm = 1.71 m) breaks the source table's own
sequence, so it is refused rather than used. Weight is never estimated: the
published equations' standard errors (about 4–14 kg) are too coarse to base a
BMI on.

**Weight that can't be measured.** With `estimate_weight_if_missing: true` (an
explicit opt-in — never done implicitly) and no `weight_kg`, `adult_integrated_screen`
estimates weight from `muac_mm` plus `calf_circumference_cm` (65+, optional
`subscapular_skinfold_mm` and `knee_height_cm`) and/or `knee_height_cm` + `race`
(ages up to 80), using the same functions as `weight_estimate_persons_65_and_older`
and `weight_from_knee_height_and_mac`; the lowest standard error wins and the others
are listed in `measurements.weight_estimate.alternatives`. The standard errors are
large (about 4–5 kg for the 65+ set, 7–14.5 kg for the race-specific set), so the
output labels the weight as estimated (`weight_source`, `weight_error_kg`, a
`bmi_from_estimated_weight` flag, limitations), gives `bmi_range_from_estimate_error`
(which also folds in a knee-height stature error), and raises
`bmi_classification_uncertain` when that range crosses a NACS BMI cut-off. It affects
BMI and MUST only — never MUAC, oedema or weight-loss findings. It is not available in
`school_age_integrated_screen`.

Age boundaries follow NACS: under-5 tool is 0–59 months, school-age is
60 months to under 18 years, adult is 18+. Not assessed for 5–19 years:
height-for-age and weight-for-age (no reference loaded here).

## Connecting an MCP client

Same as the Render deployment: point the client at
`https://<your-worker-subdomain>.workers.dev/mcp` with
`Authorization: Bearer <MCP_AUTH_TOKEN>`, or use the OAuth flow
(`/.well-known/oauth-authorization-server`) for clients like Claude.ai's
custom connector UI that don't support raw bearer tokens.

## Health check

`GET /health` → `{"status":"ok","service":"chakudya-mcp-server-cloudflare",...}`
