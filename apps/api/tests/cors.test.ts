import { describe, it, expect, afterEach } from "vitest";
import app, { allowedOrigins } from "../src/app.js";

describe("allowedOrigins (CORS の許可オリジン)", () => {
  // #257 L-3: localhost:3000 の許可は allowLocalhost フラグ次第
  it("localhost 許可 + 複数オリジン → 全部含まれる", () => {
    expect(
      allowedOrigins("https://dm-ai.shiyow.dev, https://dm-ai-web.shiyow.workers.dev", true),
    ).toEqual([
      "http://localhost:3000",
      "https://dm-ai.shiyow.dev",
      "https://dm-ai-web.shiyow.workers.dev",
    ]);
  });

  it("localhost 不許可 → 許可リストのみ (#257 L-3)", () => {
    expect(
      allowedOrigins("https://dm-ai.shiyow.dev, https://dm-ai-web.shiyow.workers.dev", false),
    ).toEqual(["https://dm-ai.shiyow.dev", "https://dm-ai-web.shiyow.workers.dev"]);
  });

  it("未設定 + localhost 許可 → ローカル開発のみ", () => {
    expect(allowedOrigins(undefined, true)).toEqual(["http://localhost:3000"]);
    expect(allowedOrigins("", true)).toEqual(["http://localhost:3000"]);
  });

  it("未設定 + localhost 不許可 → 空配列", () => {
    expect(allowedOrigins(undefined, false)).toEqual([]);
    expect(allowedOrigins("", false)).toEqual([]);
  });

  it("空要素・余分な空白は落とす", () => {
    expect(allowedOrigins(" https://a.example , , https://b.example ", true)).toEqual([
      "http://localhost:3000",
      "https://a.example",
      "https://b.example",
    ]);
  });

  // #273 R2: WEB_URL 内の localhost / 不正な Origin
  it("localhost 不許可なら WEB_URL 内の localhost 系も除外 (#273 R2)", () => {
    expect(
      allowedOrigins("https://a.example,http://localhost:3000,http://127.0.0.1:8787", false),
    ).toEqual(["https://a.example"]);
  });

  it("localhost 許可なら WEB_URL 内の localhost も残る", () => {
    expect(allowedOrigins("http://localhost:4000", true)).toEqual([
      "http://localhost:3000",
      "http://localhost:4000",
    ]);
  });

  // 正規化 (#273 追加対応)
  it("末尾スラッシュ・大文字ホスト・既定ポート明示を正規化して受け付ける", () => {
    expect(allowedOrigins("https://A.Example/", false)).toEqual(["https://a.example"]);
    expect(allowedOrigins("https://a.example:443", false)).toEqual(["https://a.example"]);
    expect(allowedOrigins("http://a.example:80/", false)).toEqual(["http://a.example"]);
    expect(allowedOrigins("https://a.example:8443", false)).toEqual(["https://a.example:8443"]);
  });

  it("正規化後に重複したものは 1 つにまとめる", () => {
    expect(allowedOrigins("https://a.example,https://A.EXAMPLE:443/", false)).toEqual([
      "https://a.example",
    ]);
    expect(allowedOrigins("http://localhost:3000/,HTTP://LOCALHOST:3000", true)).toEqual([
      "http://localhost:3000",
    ]);
  });

  it("クエリ・フラグメント・認証情報付きは捨てる", () => {
    expect(
      allowedOrigins(
        "https://a.example?x=1,https://a.example#f,https://u:p@a.example,https://a.example/?",
        false,
      ),
    ).toEqual([]);
  });

  it.each([
    "http://127.0.0.1:8787",
    "http://127.1.2.3",
    "http://127.255.255.254:3000",
    "http://0.0.0.0:3000",
    "http://localhost.:3000",
    "http://LOCALHOST:3000/",
    "http://app.localhost:3000",
    "http://[::1]:3000",
  ])("localhost 不許可なら %s も除外", (o) => {
    expect(allowedOrigins(`https://a.example,${o}`, false)).toEqual(["https://a.example"]);
  });

  it("localhost でない近い名前は除外しない", () => {
    expect(
      allowedOrigins("http://128.0.0.1,http://localhost.example,http://10.0.0.1", false),
    ).toEqual(["http://128.0.0.1", "http://localhost.example", "http://10.0.0.1"]);
  });

  it("`*` / null / パス付き / 非 http(s) は捨てる (#273 R2)", () => {
    expect(
      allowedOrigins("*,null,https://a.example/path,ftp://a.example,https://ok.example", false),
    ).toEqual(["https://ok.example"]);
  });
});

describe("CORS ミドルウェア (env と process.env の混在, #273 R2)", () => {
  const orig = process.env.ALLOW_ANONYMOUS;
  afterEach(() => {
    if (orig === undefined) delete process.env.ALLOW_ANONYMOUS;
    else process.env.ALLOW_ANONYMOUS = orig;
  });

  const preflight = (env: Record<string, string>, origin = "http://localhost:3000") =>
    app.request(
      "/health",
      {
        method: "OPTIONS",
        headers: { Origin: origin, "Access-Control-Request-Method": "GET" },
      },
      env,
    );

  // 許可されない Origin には Allow-Origin を一切返さない (空文字・別オリジンの返却も不可)
  const allowOrigin = (res: Response) => res.headers.get("access-control-allow-origin");

  it("env=false / process=true → 認証と同じく匿名拒否 = localhost も許可しない", async () => {
    process.env.ALLOW_ANONYMOUS = "true";
    const res = await preflight({ ALLOW_ANONYMOUS: "false", WEB_URL: "https://a.example" });
    // 比較対象が正しく許可されることも同時に確認 (設定ミスによる偽陽性防止)
    const ok = await preflight(
      { ALLOW_ANONYMOUS: "false", WEB_URL: "https://a.example" },
      "https://a.example",
    );
    expect(allowOrigin(ok)).toBe("https://a.example");
    expect(allowOrigin(res) ?? "").toBe("");
  });

  it("env=true → localhost 許可", async () => {
    delete process.env.ALLOW_ANONYMOUS;
    const res = await preflight({ ALLOW_ANONYMOUS: "true", WEB_URL: "https://a.example" });
    expect(res.status).toBe(204);
    expect(allowOrigin(res)).toBe("http://localhost:3000");
  });

  it("本番相当 (フラグ未設定) で WEB_URL に localhost があっても許可しない", async () => {
    delete process.env.ALLOW_ANONYMOUS;
    const env = { WEB_URL: "https://a.example,http://localhost:3000,http://127.0.0.2:3000" };
    for (const o of ["http://localhost:3000", "http://127.0.0.2:3000"]) {
      expect(allowOrigin(await preflight(env, o)) ?? "").toBe("");
    }
    expect(allowOrigin(await preflight(env, "https://a.example"))).toBe("https://a.example");
  });

  it("WEB_URL の表記ゆれ (末尾スラッシュ・大文字・既定ポート) でも本来の Origin が許可される", async () => {
    delete process.env.ALLOW_ANONYMOUS;
    const res = await preflight({ WEB_URL: "https://A.Example:443/" }, "https://a.example");
    expect(allowOrigin(res)).toBe("https://a.example");
  });
});
