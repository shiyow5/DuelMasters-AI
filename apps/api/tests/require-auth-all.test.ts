import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const getUserMock = vi.fn();
vi.mock("@dm-ai/db", () => ({
  getSupabase: () => ({ auth: { getUser: getUserMock } }),
  configureDb: () => {},
  getSql: () => {
    throw new Error("DB には到達しないはず (認証で弾かれる)");
  },
}));

const app = (await import("../src/app.js")).default;

/** LLM コストや DB 負荷がかかる経路。無認証で叩けてはいけない。 */
const PROTECTED = [
  ["POST", "/api/chat", { message: "x", mode: "rule" }],
  ["POST", "/api/deck/build", { theme: "x" }],
  ["POST", "/api/deck/evaluate", { decklist: "4 x" }],
  ["POST", "/api/deck/parse", { decklist: "4 x" }],
  ["POST", "/api/deck/suggest", { decklist: "4 x", goals: ["除去"] }],
  ["GET", "/api/meta/tier", null],
  ["GET", "/api/meta/archetype/x", null],
] as const;

/** Workers の env は Hono の第3引数で渡す (未指定だと c.env が undefined で dbEnv が落ちる)。 */
const ENV = {};

function req(method: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(
    path,
    {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
    ENV,
  );
}

describe("全 API がログイン必須", () => {
  beforeEach(() => {
    getUserMock.mockReset();
    process.env.INTERNAL_API_KEY = "test-key";
    delete process.env.ALLOW_ANONYMOUS;
  });
  afterEach(() => {
    delete process.env.ALLOW_ANONYMOUS;
  });

  it.each(PROTECTED)("%s %s は無認証だと 401", async (method, path, body) => {
    // /api/chat は Gemini を叩く = 第三者に課金を消費されるため、無認証で通してはいけない。
    const res = await req(method, path, body);
    expect(res.status).toBe(401);
  });

  it("ヘルスチェックは無認証で通る (監視のため)", async () => {
    const res = await app.request("/", {}, ENV);
    expect(res.status).toBe(200);
  });

  it("bot の内部キー経由は通る (Discord ユーザーは Supabase ログインできない)", async () => {
    // 認証は通るが、DB に到達すると mock が throw する = 401 で止まっていないことの確認。
    const res = await req(
      "POST",
      "/api/deck/parse",
      { decklist: "4 x" },
      { "X-Internal-Key": "test-key", "X-User-Id": "discord:1" },
    );
    expect(res.status).not.toBe(401);
  });

  it("Supabase の Bearer 経由は通る", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
    const res = await req(
      "POST",
      "/api/deck/parse",
      { decklist: "4 x" },
      { Authorization: "Bearer tok" },
    );
    expect(res.status).not.toBe(401);
  });

  it("ALLOW_ANONYMOUS=true なら無認証を通す (E2E / ローカル開発のみ)", async () => {
    // 既定は認証必須 (fail-closed)。本番 Worker はこのフラグを設定しない。
    process.env.ALLOW_ANONYMOUS = "true";
    const res = await req("POST", "/api/deck/parse", { decklist: "4 x" });
    expect(res.status).not.toBe(401);
  });

  it("ALLOW_ANONYMOUS が true 以外なら認証必須のまま", async () => {
    process.env.ALLOW_ANONYMOUS = "1";
    expect((await req("POST", "/api/deck/parse", { decklist: "4 x" })).status).toBe(401);
    process.env.ALLOW_ANONYMOUS = "false";
    expect((await req("POST", "/api/deck/parse", { decklist: "4 x" })).status).toBe(401);
  });
});
