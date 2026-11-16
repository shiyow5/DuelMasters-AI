import { describe, it, expect } from "vitest";
import { allowedOrigins } from "../src/app.js";

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
});
