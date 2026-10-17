import { describe, it, expect, beforeEach } from "vitest";
import { initEnv } from "../../config/env.js";
import { createChakudyaMcpServer } from "../../server/createServer.js";

/**
 * Contract tests for the 8 food tools: each must call the right chakudya-api
 * route with the right query parameters and the consumer key, and turn the API's
 * answer into a sensible tool result. The API is faked at the service-binding
 * boundary, so nothing here touches the network.
 */

type Call = { path: string; query: Record<string, string>; auth: string | null };
type Route = { status?: number; body: unknown };

let calls: Call[];
let routes: Record<string, Route>;

const fakeApi = {
  fetch: async (input: string, init: RequestInit) => {
    const url = new URL(input);
    const headers = new Headers(init.headers);
    calls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), auth: headers.get("authorization") });
    const route = routes[url.pathname];
    if (!route) return Response.json({ status: "error", message: "Not found" }, { status: 404 });
    return Response.json(route.body, { status: route.status ?? 200 });
  },
} as unknown as Fetcher;

const okBody = (data: unknown, extra: Record<string, unknown> = {}) => ({ status: "success", data, ...extra });
const food = (id: number, name: string) => ({ id, name, category: "Cereals", energy_kcal: 350 });

type Registered = { inputSchema?: { parse: (v: unknown) => unknown }; handler: (a: unknown, e: unknown) => Promise<{ isError?: boolean; content: { text: string }[] }> };

async function call(name: string, args: Record<string, unknown>) {
  const server = createChakudyaMcpServer("contract", ["food"]) as unknown as { _registeredTools: Record<string, Registered> };
  const tool = server._registeredTools[name];
  expect(tool, `${name} is not registered`).toBeDefined();
  const parsed = tool.inputSchema ? tool.inputSchema.parse(args) : args; // applies zod defaults like the SDK does
  const res = await tool.handler(parsed, {});
  return { res, json: () => JSON.parse(res.content[0].text) };
}

beforeEach(() => {
  calls = [];
  routes = {};
  initEnv({ ENVIRONMENT: "development", CHAKUDYA_API: fakeApi, CHAKUDYA_API_KEY: "cnr_consumer" });
});

describe("search_food", () => {
  it("uses the local database first", async () => {
    routes["/foods"] = { body: okBody([food(1, "Nsima")]) };
    const { json } = await call("search_food", { query: "nsima" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ path: "/foods", query: { search: "nsima", limit: "10" }, auth: "Bearer cnr_consumer" });
    expect(json().source).toBe("local_database");
    expect(json().data).toHaveLength(1);
  });

  it("falls through local, fuzzy, then the wider tier when nothing matches", async () => {
    routes["/foods"] = { body: okBody([]) };
    routes["/foods/search"] = { body: okBody([]) };
    routes["/foods/lookup"] = { body: okBody(food(9, "Banana")) };
    const { json } = await call("search_food", { query: "banan" });
    expect(calls.map((c) => c.path)).toEqual(["/foods", "/foods/search", "/foods/lookup"]);
    expect(calls[1].query).toMatchObject({ q: "banan", max_results: "10" });
    expect(json().source).toBe("cnr_wider_tier");
  });
});

describe("get_food_details", () => {
  it("fetches /foods/:id", async () => {
    routes["/foods/42"] = { body: okBody(food(42, "Mgaiwa")) };
    const { json } = await call("get_food_details", { food_id: 42 });
    expect(calls[0].path).toBe("/foods/42");
    expect(json().name ?? json().data?.name).toBeDefined();
  });

  it("reports an unknown id as a tool error, not an exception", async () => {
    const { res } = await call("get_food_details", { food_id: 999 });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/No matching data/i);
  });
});

describe("barcode_lookup", () => {
  it("searches the packaged table by barcode", async () => {
    routes["/packaged"] = { body: okBody([{ id: 5, name: "Maize flour", barcode: "6001234567890" }]) };
    await call("barcode_lookup", { barcode: "6001234567890" });
    expect(calls[0]).toMatchObject({ path: "/packaged", query: { barcode: "6001234567890" } });
  });

  it("falls back to /foods/lookup when the packaged table has no match", async () => {
    routes["/packaged"] = { body: okBody([]) };
    routes["/foods/lookup"] = { body: okBody(food(3, "Cola")) };
    await call("barcode_lookup", { barcode: "5449000000996" });
    expect(calls.map((c) => c.path)).toEqual(["/packaged", "/foods/lookup"]);
    expect(calls[1].query.barcode).toBe("5449000000996");
  });
});

describe("packaged_food_search", () => {
  it("passes search and limit to /packaged with no wider-tier fallback", async () => {
    routes["/packaged"] = { body: okBody([]) };
    await call("packaged_food_search", { query: "flour" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ path: "/packaged", query: { search: "flour", limit: "10" } });
  });
});

describe("foods_autocomplete", () => {
  it("sends the partial text as q with max_results", async () => {
    routes["/foods/autocomplete"] = { body: okBody(["Chicken", "Chickpea"]) };
    await call("foods_autocomplete", { query: "chic" });
    expect(calls[0]).toMatchObject({ path: "/foods/autocomplete", query: { q: "chic", max_results: "4" } });
  });
});

describe("foods_categories", () => {
  it("lists categories with no parameters", async () => {
    routes["/foods/categories"] = { body: okBody(["Cereals", "Legumes"]) };
    await call("foods_categories", {});
    expect(calls[0]).toMatchObject({ path: "/foods/categories", query: {} });
  });
});

describe("get_food_serving_sizes", () => {
  it("asks for the food with with_servings=true", async () => {
    routes["/foods/7"] = { body: okBody({ ...food(7, "Rice"), servings: [{ label: "1 cup", grams: 180 }] }) };
    await call("get_food_serving_sizes", { food_id: "7" });
    expect(calls[0]).toMatchObject({ path: "/foods/7", query: { with_servings: "true" } });
  });
});

describe("generate_nutrition_label", () => {
  it("calls /foods/:id/label and forwards the serving filter", async () => {
    routes["/foods/7/label"] = { body: okBody({ label: "Nutrition Facts" }, { food_id: 7, food_name: "Rice" }) };
    const { json } = await call("generate_nutrition_label", { food_id: 7, serving: "cup" });
    expect(calls[0]).toMatchObject({ path: "/foods/7/label", query: { serving: "cup" } });
    expect(json().food_name).toBe("Rice");
  });

  it("omits serving when not given", async () => {
    routes["/foods/7/label"] = { body: okBody({}) };
    await call("generate_nutrition_label", { food_id: 7 });
    expect(calls[0].query).toEqual({});
  });
});

describe("all food tools", () => {
  it("send the consumer key, never the admin key", async () => {
    initEnv({ ENVIRONMENT: "development", CHAKUDYA_API: fakeApi, CHAKUDYA_API_KEY: "cnr_consumer", CHAKUDYA_ADMIN_API_KEY: "cnr_admin" });
    routes["/foods/categories"] = { body: okBody([]) };
    await call("foods_categories", {});
    expect(calls[0].auth).toBe("Bearer cnr_consumer");
  });
});
