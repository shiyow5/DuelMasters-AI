import { describe, it, expect } from "vitest";
import { allowedOrigins } from "../src/app.js";

describe("allowedOrigins (CORS の許可オリジン)", () => {
  // 移行期は workers.dev と独自ドメインの両方から web が配信される。
  // 単一オリジンしか許可できないと、どちらかの web から api を叩けなくなる。
  it("カンマ区切りで複数オリジンを許可する", () => {
    expect(
      allowedOrigins("https://dm-ai.shiyow.dev, https://dm-ai-web.shiyow.workers.dev"),
    ).toEqual([
      "http://localhost:3000",
      "https://dm-ai.shiyow.dev",
      "https://dm-ai-web.shiyow.workers.dev",
    ]);
  });

  it("未設定ならローカル開発のみ許可する", () => {
    expect(allowedOrigins(undefined)).toEqual(["http://localhost:3000"]);
    expect(allowedOrigins("")).toEqual(["http://localhost:3000"]);
  });

  it("空要素・余分な空白は落とす", () => {
    expect(allowedOrigins(" https://a.example , , https://b.example ")).toEqual([
      "http://localhost:3000",
      "https://a.example",
      "https://b.example",
    ]);
  });
});
