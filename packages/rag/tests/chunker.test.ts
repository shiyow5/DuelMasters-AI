import { describe, it, expect } from "vitest";
import { chunkRuleText, chunkFaqText, chunkBySize } from "../src/chunker.js";

describe("chunker 特性テスト", () => {
  it("chunkRuleText: 節見出しだけのチャンクは出さず、条文に見出しを付ける", () => {
    // 節見出しの直後は条文なので、見出し行がそれ単体でチャンクになってしまう。
    // 実データでは 600 チャンク中 248 件が本文なしの見出しで、検索上位を占有していた。
    const rule = [
      "100. セクションA",
      "100.1. 条文1本文",
      "続きの行",
      "100.2a. 条文2本文",
      "101. セクションB",
      "セクション本文",
    ].join("\n");
    expect(chunkRuleText(rule)).toEqual([
      {
        text: "100. セクションA\n100.1. 条文1本文\n続きの行",
        meta: { section: "100", sectionTitle: "セクションA", article: "100.1" },
      },
      {
        text: "100. セクションA\n100.2a. 条文2本文",
        meta: { section: "100", sectionTitle: "セクションA", article: "100.2a" },
      },
      {
        text: "101. セクションB\nセクション本文",
        meta: { section: "101", sectionTitle: "セクションB" },
      },
    ]);
  });

  it("chunkRuleText: 本文の無い見出しが連続しても捨てる", () => {
    expect(chunkRuleText(["200. 見出しのみA", "201. 見出しのみB"].join("\n"))).toEqual([]);
  });

  it("chunkFaqText: Q単位分割・10文字未満は捨てる", () => {
    const faq =
      "Q: 質問その1ですか？ A: 回答その1です。\nQ: 質問その2ですか？ A: 回答その2です。\nQ:短い";
    expect(chunkFaqText(faq)).toEqual([
      { text: "Q: 質問その1ですか？ A: 回答その1です。", meta: {} },
      { text: "Q: 質問その2ですか？ A: 回答その2です。", meta: {} },
    ]);
  });

  it("chunkBySize: サイズ分割とオーバーラップ", () => {
    const text = "あ".repeat(30) + "。" + "い".repeat(30) + "。" + "う".repeat(30) + "。";
    expect(chunkBySize(text, 40, 5)).toEqual([
      { text: "あ".repeat(30) + "。", meta: {} },
      { text: "ああああ。" + "い".repeat(30) + "。", meta: {} },
      { text: "いいいい。" + "う".repeat(30) + "。", meta: {} },
    ]);
  });
});
