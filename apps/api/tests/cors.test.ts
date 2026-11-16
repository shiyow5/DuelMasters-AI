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

  const preflight = (env: Record<string, string>) =>
    app.request(
      "/health",
      {
        method: "OPTIONS",
        headers: { Origin: "http://localhost:3000", "Access-Control-Request-Method": "GET" },
      },
      env,
    );

  it("env=false / process=true → 認証と同じく匿名拒否 = localhost も許可しない", async () => {
    process.env.ALLOW_ANONYMOUS = "true";
    const res = await preflight({ ALLOW_ANONYMOUS: "false", WEB_URL: "https://a.example" });
    expect(res.headers.get("access-control-allow-origin")).not.toBe("http://localhost:3000");
  });

  it("env=true → localhost 許可", async () => {
    delete process.env.ALLOW_ANONYMOUS;
    const res = await preflight({ ALLOW_ANONYMOUS: "true", WEB_URL: "https://a.example" });
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
  });

  it("本番相当 (フラグ未設定) で WEB_URL に localhost があっても許可しない", async () => {
    delete process.env.ALLOW_ANONYMOUS;
    const res = await preflight({ WEB_URL: "https://a.example,http://localhost:3000" });
    expect(res.headers.get("access-control-allow-origin")).not.toBe("http://localhost:3000");
  });
});
