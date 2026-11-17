import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { Hono } from "hono";

/**
 * deck の `/:id` パラメータ検証 (z.coerce.number().int().positive())。zod 3→4 で coerce の
 * 入力型が変わったため、境界を固定する。DB は mock し、検証を通った id だけが SQL に届くことを見る。
 * 不正な id は 404 (「見つかりません」。400 ではない) で、SQL には到達しない。
 */
const sqlCalls: unknown[][] = [];
vi.mock("@dm-ai/db", () => ({
  getSupabase: () => ({}),
  configureDb: () => {},
  getSql:
    () =>
    async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      sqlCalls.push(values);
      return [];
    },
}));

const { optionalAuth } = await import("../src/middleware/auth.js");
const { deckRouter } = await import("../src/routes/deck.js");

const HEADERS = { "X-Internal-Key": "test-key", "X-User-Id": "discord:2001" };

function makeApp() {
  const app = new Hono();
  app.use("*", optionalAuth);
  app.route("/api/deck", deckRouter);
  return app;
}

describe.each(["GET", "DELETE"])("deck /:id (%s)", (method) => {
  beforeAll(() => {
    process.env.INTERNAL_API_KEY = "test-key";
  });
  beforeEach(() => {
    sqlCalls.length = 0;
  });

  it.each(["0", "-1", "abc", "1.5"])("id=%s は 404 で SQL に到達しない", async (id) => {
    const res = await makeApp().request(`/api/deck/${id}`, { method, headers: HEADERS });
    expect(res.status).toBe(404);
    expect(sqlCalls).toEqual([]);
  });

  it("id=1 は検証を通り、数値 1 で SQL に到達する", async () => {
    const res = await makeApp().request("/api/deck/1", { method, headers: HEADERS });
    expect(res.status).not.toBe(400);
    expect(sqlCalls.flat()).toContain(1);
  });
});
