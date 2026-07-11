import { describe, it, expect } from "vitest";
import { chunkRuleText, chunkFaqText, chunkBySize } from "../src/chunker.js";

describe("chunker 特性テスト", () => {
  it("chunkRuleText: セクション・条文単位の分割", () => {
    const rule = [
      "100. セクションA",
      "100.1. 条文1本文",
      "続きの行",
      "100.2a. 条文2本文",
      "101. セクションB",
      "セクション本文",
    ].join("\n");
    expect(chunkRuleText(rule)).toEqual([
      { text: "100. セクションA", meta: { section: "100" } },
      { text: "100.1. 条文1本文\n続きの行", meta: { section: "100", article: "100.1" } },
      { text: "100.2a. 条文2本文", meta: { section: "100", article: "100.2a" } },
      { text: "101. セクションB\nセクション本文", meta: { section: "101" } },
    ]);
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
