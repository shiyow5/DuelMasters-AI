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
      overall: 30,
      warnings: [
        "S・トリガーが0枚です (推奨: 8枚以上)",
        "低コスト(3以下)が0枚です (推奨: 15枚)",
        "受け札が少なく、攻撃に弱い構成です",
      ],
      suggestions: [
        "S・トリガー持ちのカードを追加して防御力を上げましょう",
        "初動で使える低コストカードを増やしましょう",
        "S・トリガーやブロッカーなどの受け札を追加しましょう",
        "ドローソースを増やしてリソース確保を安定させましょう",
      ],
    });
  });
});
