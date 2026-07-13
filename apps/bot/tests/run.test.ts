import { describe, it, expect, beforeEach, vi } from "vitest";
import { runCommand, type BotEnv } from "../src/interactions/run.js";

const ENV: BotEnv = { API_URL: "https://api.test", INTERNAL_API_KEY: "secret" };

/** 呼ばれた URL とレスポンスを記録するフェイク fetch */
function mockFetch(routes: Record<string, unknown>) {
  const calls: Array<{ url: string; method: string; body?: unknown; headers: Headers }> = [];
  const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = url.replace("https://api.test", "");
    calls.push({
      url: path,
      method: init.method ?? "GET",
      body: init.body ? JSON.parse(init.body as string) : undefined,
      headers: new Headers(init.headers as HeadersInit),
    });
    const key = Object.keys(routes).find((k) => path.startsWith(k));
    if (!key) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(routes[key]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

beforeEach(() => vi.unstubAllGlobals());

describe("runCommand", () => {
  it("rule: /api/chat を mode=rule で叩き embed を返す", async () => {
    const calls = mockFetch({ "/api/chat": { response: "S・トリガーは任意です" } });
    const msg = await runCommand(
      { group: undefined, sub: "rule", options: { question: "S・トリガーとは？" } },
      "123",
      ENV,
    );
    expect(calls[0]).toMatchObject({
      url: "/api/chat",
      method: "POST",
      body: { message: "S・トリガーとは？", mode: "rule" },
    });
    expect(msg.embeds?.[0].description).toContain("任意");
  });

  it("deck build: ユーザー設定のフォーマットを api から引いて渡す", async () => {
    // Worker はリクエストごとに使い捨てなので、インメモリ Map ではなく毎回 api を引く。
    const calls = mockFetch({
      "/api/user/settings": { format: "advance" },
      "/api/deck/build": { entries: [{ name: "火1", count: 4 }] },
    });
    const msg = await runCommand(
      { group: "deck", sub: "build", options: { theme: "速攻" } },
      "123",
      ENV,
    );
    expect(calls[0].url).toBe("/api/user/settings");
    expect(calls[1]).toMatchObject({
      url: "/api/deck/build",
      body: { theme: "速攻", format: "advance" },
    });
    expect(msg.embeds?.[0].description).toContain("4 火1");
  });

  it("deck save: 内部認証ヘッダを付ける", async () => {
    const calls = mockFetch({
      "/api/user/settings": { format: "original" },
      "/api/deck/save": { scores: { overall: 72 } },
    });
    const msg = await runCommand(
      { group: "deck", sub: "save", options: { list: "4 火1", name: "速攻デッキ" } },
      "999",
      ENV,
    );
    const save = calls.find((c) => c.url === "/api/deck/save")!;
    expect(save.headers.get("X-Internal-Key")).toBe("secret");
    expect(save.headers.get("X-User-Id")).toBe("discord:999");
    expect(msg.embeds?.[0].description).toContain("72");
  });

  it("meta tier: データが無ければその旨を返す", async () => {
    mockFetch({
      "/api/user/settings": { format: "original" },
      "/api/meta/tier": { tier_data: [] },
    });
    const msg = await runCommand({ group: "meta", sub: "tier", options: {} }, "1", ENV);
    expect(msg.content).toContain("ティアデータがまだありません");
  });

  it("API エラーは throw せずエラー本文にする (follow-up が送られないと考え中のまま固まる)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 })),
    );
    const msg = await runCommand(
      { group: undefined, sub: "rule", options: { question: "?" } },
      "1",
      ENV,
    );
    expect(msg.content).toContain("エラー");
  });

  it("フォーマット取得に失敗しても既定 (original) で続行する", async () => {
    const calls = mockFetch({ "/api/deck/build": { entries: [] } }); // /api/user/settings は 404
    await runCommand({ group: "deck", sub: "build", options: { theme: "x" } }, "1", ENV);
    const build = calls.find((c) => c.url === "/api/deck/build")!;
    expect(build.body).toMatchObject({ format: "original" });
  });

  it("すべての api 呼び出しに内部認証ヘッダを付ける", async () => {
    // api は全エンドポイントがログイン必須になった。Discord ユーザーは Supabase ログインを
    // 持たないため、bot は内部キー + Discord ID で認証する。1つでも欠けるとそのコマンドが 401。
    const cases: Array<[Parameters<typeof runCommand>[0], Record<string, unknown>]> = [
      [
        { group: undefined, sub: "rule", options: { question: "q" } },
        { "/api/chat": { response: "a" } },
      ],
      [
        { group: undefined, sub: "chat", options: { message: "m" } },
        { "/api/chat": { response: "a" } },
      ],
      [
        { group: "deck", sub: "build", options: { theme: "t" } },
        { "/api/user/settings": { format: "original" }, "/api/deck/build": { entries: [] } },
      ],
      [
        { group: "deck", sub: "rate", options: { list: "4 x" } },
        {
          "/api/user/settings": { format: "original" },
          "/api/deck/evaluate": {
            score: {
              overall: 1,
              triggerCount: 0,
              rainbowCount: 0,
              openingHandRate: 0,
              costCurve: { low: 0, mid: 0, high: 0 },
              warnings: [],
            },
            validation: { valid: true, errors: [], warnings: [] },
          },
        },
      ],
      [
        { group: "meta", sub: "tier", options: {} },
        {
          "/api/user/settings": { format: "original" },
          "/api/meta/tier": { tier_data: [{ tier: "Tier1", archetype: "a", usage_rate: 1 }] },
        },
      ],
      [
        { group: "meta", sub: "deck", options: { name: "a" } },
        {
          "/api/user/settings": { format: "original" },
          "/api/meta/archetype": { archetype: "a", stats: null },
        },
      ],
    ];

    for (const [parsed, routes] of cases) {
      const calls = mockFetch(routes);
      await runCommand(parsed, "42", ENV);
      for (const call of calls) {
        expect(call.headers.get("X-Internal-Key"), `${parsed.sub} → ${call.url}`).toBe("secret");
        expect(call.headers.get("X-User-Id"), `${parsed.sub} → ${call.url}`).toBe("discord:42");
      }
    }
  });
});
