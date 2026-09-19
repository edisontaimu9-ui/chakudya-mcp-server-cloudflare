import { defineConfig } from "vitest/config";

/**
 * Plain Node vitest config — no Cloudflare Workers pool needed. The tests
 * target pure functions exported from src/tools/*.ts (e.g.
 * under5MalnutritionScreeningTools.ts), not the MCP server transport or
 * the Chakudya API client, so a standard Node test environment is enough.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
