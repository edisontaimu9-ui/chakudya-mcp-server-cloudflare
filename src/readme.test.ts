// Not type-checked by tsc (tsconfig excludes it): it uses Node fs/process, and this project only loads Workers types. vitest runs it as normal.
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { initEnv } from "./config/env.js";
import { createChakudyaMcpServer } from "./server/createServer.js";

/**
 * Keeps the README's tool list in step with what the server really registers,
 * so the docs can't drift from the code again.
 *
 * Regenerate after adding/removing a tool:
 *   UPDATE_README=1 npx vitest run src/readme.test.ts
 */
const README = new URL("../README.md", import.meta.url);
const START = "<!-- TOOLS:START -->";
const END = "<!-- TOOLS:END -->";

function registeredTools(): string[] {
  initEnv({ ENVIRONMENT: "development" });
  const server = createChakudyaMcpServer("readme-test") as unknown as {
    _registeredTools: Record<string, unknown>;
  };
  return Object.keys(server._registeredTools).sort();
}

function render(names: string[]): string {
  return `**${names.length} tools:** ${names.map((n) => `\`${n}\``).join(", ")}`;
}

describe("README tool list", () => {
  it("matches the tools the server registers", () => {
    const names = registeredTools();
    let text = readFileSync(README, "utf8");
    const a = text.indexOf(START);
    const b = text.indexOf(END);
    expect(a, "README is missing the TOOLS:START marker").toBeGreaterThan(-1);
    expect(b, "README is missing the TOOLS:END marker").toBeGreaterThan(a);

    if (process.env.UPDATE_README === "1") {
      text = `${text.slice(0, a + START.length)}\n${render(names)}\n${text.slice(b)}`;
      writeFileSync(README, text);
      return;
    }

    const block = text.slice(a + START.length, b);
    const documented = [...block.matchAll(/`([a-z0-9_]+)`/g)].map((m) => m[1]).sort();
    const missing = names.filter((n) => !documented.includes(n));
    const extra = documented.filter((n) => !names.includes(n));
    expect(
      { missingFromReadme: missing, listedButNotRegistered: extra },
      "README tool list is out of date. Run: UPDATE_README=1 npx vitest run src/readme.test.ts"
    ).toEqual({ missingFromReadme: [], listedButNotRegistered: [] });
  });
});
