import { z } from "zod";

/**
 * Cloudflare Workers has no `process.env` / dotenv — configuration arrives
 * per-request as the `env` object passed into the `fetch` handler (vars from
 * wrangler.jsonc's `vars`, and secrets set via `wrangler secret put`).
 *
 * We validate it once (on the first request this isolate handles) and cache
 * the result, since these values are fixed at deploy time and don't change
 * request-to-request. Every module that used to `import { env }` directly
 * now calls `getEnv()` instead.
 */

// Shape of the raw bindings object Cloudflare hands to fetch(request, env, ctx).
export interface WorkerBindings {
  CHAKUDYA_API_BASE_URL?: string;
  CHAKUDYA_ADMIN_API_KEY?: string;
  MCP_AUTH_TOKEN?: string;
  MCP_ALLOWED_ORIGINS?: string;
  MCP_RATE_LIMIT_PER_MIN?: string;
  ENVIRONMENT?: string; // "production" | "development" — set via vars if you want dev logging
  /**
   * Service binding to the chakudya-api Worker (see the "services" entry in
   * wrangler.jsonc). Not a plain string, so it's kept out of EnvSchema below
   * and cached separately — see getChakudyaApiBinding(). Optional because it
   * won't exist in local `wrangler dev` runs without --remote, or if the
   * binding is ever removed from wrangler.jsonc; chakudyaClient.ts falls
   * back to a plain public fetch() against CHAKUDYA_API_BASE_URL when this
   * is undefined.
   */
  CHAKUDYA_API?: Fetcher;
}

const EnvSchema = z.object({
  CHAKUDYA_API_BASE_URL: z.string().url().default("https://chakudya-api.edisontaimu9.workers.dev"),
  CHAKUDYA_ADMIN_API_KEY: z.string().optional(),
  MCP_AUTH_TOKEN: z.string().optional(),
  MCP_ALLOWED_ORIGINS: z
    .string()
    .optional()
    .transform((v) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean)),
  MCP_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(60),
  ENVIRONMENT: z.enum(["development", "production"]).default("production"),
});

export type AppEnv = z.infer<typeof EnvSchema>;

let cached: AppEnv | undefined;
let cachedServiceBinding: Fetcher | undefined;

/** Call once at the top of the fetch handler, before anything else touches config. */
export function initEnv(raw: WorkerBindings): AppEnv {
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    // Thrown, not process.exit(1) — Workers has no process to exit; the
    // caller (index.ts) turns this into a 500 response.
    throw new Error(
      `[env] Invalid Worker configuration: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`
    );
  }

  // Workers is a serverless request-response model: unlike the Render
  // deployment, there's no single "startup" moment to fail loudly at, so we
  // enforce the same "auth required in production" rule here, per-request,
  // the first time config is read.
  if (parsed.data.ENVIRONMENT === "production" && !parsed.data.MCP_AUTH_TOKEN) {
    throw new Error(
      "[env] MCP_AUTH_TOKEN is required. Set it with: npx wrangler secret put MCP_AUTH_TOKEN"
    );
  }

  cached = parsed.data;
  cachedServiceBinding = raw.CHAKUDYA_API;
  return cached;
}

/** Read validated config. Throws if initEnv() hasn't run yet this isolate. */
export function getEnv(): AppEnv {
  if (!cached) {
    throw new Error("[env] getEnv() called before initEnv(). This is a bug in index.ts.");
  }
  return cached;
}

/**
 * Read the chakudya-api service binding, if present this isolate. Returns
 * undefined (not a throw) when unset, so callers can cleanly fall back to a
 * plain public fetch() — see chakudyaClient.ts.
 */
export function getChakudyaApiBinding(): Fetcher | undefined {
  return cachedServiceBinding;
}
