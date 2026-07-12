import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { Hono } from "hono";
import { getTestSql, hasTestDb, enableAppDb, truncateAll } from "../../../tests/helpers/db.js";
import { optionalAuth } from "../src/middleware/auth.js";
import { userRouter } from "../src/routes/user.js";

function makeApp() {
  const app = new Hono();
  app.use("*", optionalAuth);
  app.route("/api/user", userRouter);
  return app;
}

const INTERNAL = { "X-Internal-Key": "test-key", "X-User-Id": "discord:me" };

function put(body: unknown) {
  return makeApp().request("/api/user/settings", {
    method: "PUT",
    headers: { ...INTERNAL, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// --- 認証・検証 (DB 不要) ---
describe("user settings 認証・検証", () => {
  beforeAll(() => {
    process.env.INTERNAL_API_KEY = "test-key";
  });

  it("無認証 GET → 401", async () => {
    const res = await makeApp().request("/api/user/settings");
    expect(res.status).toBe(401);
  });

  it("PUT に不正な format → 400", async () => {
    const res = await put({ format: "wrong" });
    expect(res.status).toBe(400);
  });
});

// --- UPSERT (DB 必要) ---
describe.skipIf(!hasTestDb)("user settings (統合)", () => {
  const sql = getTestSql()!;
  beforeAll(() => {
    enableAppDb();
    process.env.INTERNAL_API_KEY = "test-key";
  });
  beforeEach(async () => truncateAll(sql));
  afterAll(async () => {
    await sql.end();
  });

  it("初回 GET → original / PUT advance → GET advance", async () => {
    const g1 = await makeApp().request("/api/user/settings", {
      headers: INTERNAL,
    });
    expect(await g1.json()).toEqual({ format: "original" });

    await put({ format: "advance" });
    await put({ format: "advance" }); // UPSERT の冪等

    const g2 = await makeApp().request("/api/user/settings", {
      headers: INTERNAL,
    });
    expect(await g2.json()).toEqual({ format: "advance" });
  });
});
