import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

/**
 * /api/chat の日次クォータ (F-1)。カウンタは mock (DB での UPSERT は daily-quota-db.test.ts)。
 */

vi.mock("@dm-ai/db", () => ({
  getSql: () => {
    throw new Error("カウンタは mock なので DB には到達しないはず");
  },
}));

const { dailyChatQuota, quotaDay, DAILY_CHAT_LIMIT, DAILY_QUOTA_EXCEEDED } =
  await import("../src/middleware/daily-quota.js");

/** userId ごとの回数を持つ、メモリ上のカウンタ。 */
function memoryCounter() {
  const counts = new Map<string, number>();
  const fn = vi.fn(async (userId: string, day: string) => {
    const key = `${userId}|${day}`;
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    return n;
  });
  return fn;
}

function makeApp(counter: Parameters<typeof dailyChatQuota>[0], now?: () => Date) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("userId", c.req.header("x-user-id") ?? null);
    await next();
  });
  app.use("/api/chat/*", dailyChatQuota(counter, now));
  app.post("/api/chat", (c) => c.json({ ok: true }));
  app.post("/api/chat/stream", (c) => c.json({ ok: true }));
  app.get("/api/chat/anything", (c) => c.json({ ok: true }));
  return app;
}

const post = (app: Hono, userId: string | null, path = "/api/chat") =>
  app.request(path, { method: "POST", headers: userId ? { "x-user-id": userId } : {} });

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("dailyChatQuota", () => {
  it("上限は 100回/日", () => {
    expect(DAILY_CHAT_LIMIT).toBe(100);
  });

  it("100回目までは通り、101回目は 429 と固定文言", async () => {
    const app = makeApp(memoryCounter());
    for (let i = 0; i < DAILY_CHAT_LIMIT; i++) {
      expect((await post(app, "supabase:u1")).status).toBe(200);
    }
    const res = await post(app, "supabase:u1");
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual(DAILY_QUOTA_EXCEEDED);
  });

  it("bot (discord:) も Web と同じく数える。/api/chat と /stream は同じ枠", async () => {
    const counter = memoryCounter();
    const app = makeApp(counter);
    for (let i = 0; i < DAILY_CHAT_LIMIT / 2; i++) await post(app, "discord:42");
    for (let i = 0; i < DAILY_CHAT_LIMIT / 2; i++)
      await post(app, "discord:42", "/api/chat/stream");
    expect((await post(app, "discord:42", "/api/chat/stream")).status).toBe(429);
    expect(counter.mock.calls.every(([u]) => u === "discord:42")).toBe(true);
  });

  it("ユーザーごとに別枠 (他人の超過に巻き込まれない)", async () => {
    const app = makeApp(memoryCounter());
    for (let i = 0; i <= DAILY_CHAT_LIMIT; i++) await post(app, "supabase:heavy");
    expect((await post(app, "supabase:heavy")).status).toBe(429);
    expect((await post(app, "supabase:light")).status).toBe(200);
  });

  it("JST の日付が変われば数え直す", async () => {
    let now = new Date("2026-11-01T14:59:59Z"); // JST 23:59:59
    const app = makeApp(memoryCounter(), () => now);
    for (let i = 0; i <= DAILY_CHAT_LIMIT; i++) await post(app, "supabase:u1");
    expect((await post(app, "supabase:u1")).status).toBe(429);
    now = new Date("2026-11-01T15:00:00Z"); // JST 翌日 0:00
    expect((await post(app, "supabase:u1")).status).toBe(200);
  });

  it("POST 以外と userId なし (匿名のローカル開発) は数えない", async () => {
    const counter = memoryCounter();
    const app = makeApp(counter);
    await app.request("/api/chat/anything", { headers: { "x-user-id": "supabase:u1" } });
    await post(app, null);
    expect(counter).not.toHaveBeenCalled();
  });

  it("カウンタが落ちたら通す (fail-open) — 分単位のレート制限は別に残る", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const app = makeApp(async () => {
      throw new Error("db down");
    });
    expect((await post(app, "supabase:u1")).status).toBe(200);
    expect(console.error).toHaveBeenCalled();
  });
});

describe("quotaDay", () => {
  it("JST の日付を返す", () => {
    expect(quotaDay(new Date("2026-11-01T14:59:59Z"))).toBe("2026-11-01");
    expect(quotaDay(new Date("2026-11-01T15:00:00Z"))).toBe("2026-11-02");
  });
});
