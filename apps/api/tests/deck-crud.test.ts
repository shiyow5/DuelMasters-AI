import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { Hono } from "hono";
import { getTestSql, hasTestDb, enableAppDb, truncateAll } from "../../../tests/helpers/db.js";
import { optionalAuth } from "../src/middleware/auth.js";
import { deckRouter } from "../src/routes/deck.js";

function makeApp() {
  const app = new Hono();
  app.use("*", optionalAuth);
  app.route("/api/deck", deckRouter);
  return app;
}

const INTERNAL = { "X-Internal-Key": "test-key", "X-User-Id": "discord:me" };
const OTHER = { "X-Internal-Key": "test-key", "X-User-Id": "discord:other" };

// --- 認証ゲート (DB 不要) ---
describe("deck CRUD 認証ゲート", () => {
  beforeAll(() => {
    process.env.INTERNAL_API_KEY = "test-key";
  });

  it("無認証で save → 401", async () => {
    const res = await makeApp().request("/api/deck/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "x", format: "original", decklist: "4 A" }),
    });
    expect(res.status).toBe(401);
  });

  it("無認証で list → 401", async () => {
    const res = await makeApp().request("/api/deck/list");
    expect(res.status).toBe(401);
  });
});

// --- CRUD 本体 (DB 必要) ---
describe.skipIf(!hasTestDb)("deck CRUD (統合)", () => {
  const sql = getTestSql()!;
  beforeAll(() => {
    enableAppDb();
    process.env.INTERNAL_API_KEY = "test-key";
  });
  beforeEach(async () => truncateAll(sql));
  afterAll(async () => {
    await sql.end();
  });

  function post(path: string, body: unknown, headers: Record<string, string>) {
    return makeApp().request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }

  it("save 正常 → 201 + user_id 付きで保存、scores.overall は数値", async () => {
    const res = await post(
      "/api/deck/save",
      { title: "テスト", format: "original", decklist: "4 テストカード" },
      INTERNAL,
    );
    expect(res.status).toBe(201);
    const rows = await sql`SELECT user_id, scores FROM decks`;
    expect(rows[0].user_id).toBe("discord:me");
    expect(typeof (rows[0].scores as Record<string, unknown>).overall).toBe("number");
  });

  it("decklist パース不能のみは 400", async () => {
    const res = await post(
      "/api/deck/save",
      { title: "x", format: "original", decklist: "42" },
      INTERNAL,
    );
    expect(res.status).toBe(400);
  });

  it("list は自分のデッキのみ・降順", async () => {
    await post("/api/deck/save", { title: "mine1", format: "original", decklist: "4 A" }, INTERNAL);
    await post("/api/deck/save", { title: "theirs", format: "original", decklist: "4 B" }, OTHER);
    const res = await makeApp().request("/api/deck/list", { headers: INTERNAL });
    const body = (await res.json()) as { decks: Array<{ title: string }> };
    expect(body.decks.map((d) => d.title)).toEqual(["mine1"]);
  });

  it("他人の deck を GET/DELETE → 404、DELETE 後 GET → 404", async () => {
    const saved = await post(
      "/api/deck/save",
      { title: "mine", format: "original", decklist: "4 A" },
      INTERNAL,
    );
    const { id } = (await saved.json()) as { id: number };

    const otherGet = await makeApp().request(`/api/deck/${id}`, {
      headers: OTHER,
    });
    expect(otherGet.status).toBe(404);

    const del = await makeApp().request(`/api/deck/${id}`, {
      method: "DELETE",
      headers: INTERNAL,
    });
    expect(del.status).toBe(200);

    const getAfter = await makeApp().request(`/api/deck/${id}`, {
      headers: INTERNAL,
    });
    expect(getAfter.status).toBe(404);
  });
});
