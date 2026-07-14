import { describe, it, expect } from "vitest";
import { parseDecklist } from "../src/parser.js";
import { scoreDeck } from "../src/scorer.js";

describe("scoreDeck 特性テスト (DB無し = 全カード情報なしの劣化動作)", () => {
  it("40枚デッキ・カード情報なし", async () => {
    const deck = parseDecklist(
      Array.from({ length: 10 }, (_, i) => `4 テストカード${i + 1}`).join("\n"),
    );
    const score = await scoreDeck(deck);
    expect(score).toEqual({
      triggerCount: 0,
      rainbowCount: 0,
      costCurve: { low: 0, mid: 0, high: 0 },
      civilizationBalance: {},
      openingHandRate: 0,
      roleBalance: {},
      // #120: カード情報が1枚も引けていないのに「受け札が0枚だから減点」は誤り。
      // 役割による減点 (-25) をやめたので 30 → 55。**代わりに「参考値」と明示する**。
      overall: 55,
      warnings: [
        "S・トリガーが0枚です (推奨: 8枚以上)",
        "低コスト(3以下)が0枚です (推奨: 15枚)",
        "カード情報を取得できなかったため、この評価は参考値です",
      ],
      suggestions: [
        "S・トリガー持ちのカードを追加して防御力を上げましょう",
        "初動で使える低コストカードを増やしましょう",
      ],
    });
  });
});
