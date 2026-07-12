import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const getUserMock = vi.fn();
vi.mock("@dm-ai/db", () => ({
  getSupabase: () => ({ auth: { getUser: getUserMock } }),
}));

const { optionalAuth, requireAuth } = await import("../src/middleware/auth.js");

function makeApp() {
  const app = new Hono();
  app.use("*", optionalAuth);
  app.get("/whoami", (c) => c.json({ userId: c.get("userId") }));
  app.get("/protected", requireAuth, (c) => c.json({ userId: c.get("userId") }));
  return app;
}

describe("auth middleware", () => {
  beforeEach(() => {
    getUserMock.mockReset();
    process.env.INTERNAL_API_KEY = "test-key";
  });

  it("ヘッダ無し → userId null で通過", async () => {
    const res = await makeApp().request("/whoami");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: null });
  });

  it("X-Internal-Key 一致 + X-User-Id → discord:...", async () => {
    const res = await makeApp().request("/whoami", {
      headers: { "X-Internal-Key": "test-key", "X-User-Id": "discord:123" },
    });
    expect(await res.json()).toEqual({ userId: "discord:123" });
  });

  it("X-Internal-Key 不一致 → 401", async () => {
    const res = await makeApp().request("/whoami", {
      headers: { "X-Internal-Key": "wrong" },
    });
    expect(res.status).toBe(401);
  });

  it("INTERNAL_API_KEY 未設定でキー付き → 401", async () => {
    delete process.env.INTERNAL_API_KEY;
    const res = await makeApp().request("/whoami", {
      headers: { "X-Internal-Key": "anything" },
    });
    expect(res.status).toBe(401);
  });

  it("Bearer 有効 → supabase:<id>", async () => {
    getUserMock.mockResolvedValueOnce({
      data: { user: { id: "u1" } },
      error: null,
    });
    const res = await makeApp().request("/whoami", {
      headers: { Authorization: "Bearer tok" },
    });
    expect(await res.json()).toEqual({ userId: "supabase:u1" });
  });

  it("Bearer 無効 → 401", async () => {
    getUserMock.mockResolvedValueOnce({
      data: { user: null },
      error: { message: "bad" },
    });
    const res = await makeApp().request("/whoami", {
      headers: { Authorization: "Bearer bad" },
    });
    expect(res.status).toBe(401);
  });

  it("requireAuth: userId null → 401", async () => {
    const res = await makeApp().request("/protected");
    expect(res.status).toBe(401);
  });
});
