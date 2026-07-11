import { describe, it, expect } from "vitest";
import { parseDecklist } from "../src/parser.js";

describe("parseDecklist 特性テスト", () => {
  it("『4 カード名』形式", () => {
    expect(parseDecklist("4 ボルシャック・ドラゴン")).toEqual({
      entries: [{ count: 4, name: "ボルシャック・ドラゴン" }],
      totalCards: 4,
      errors: [],
    });
  });

  it("混在形式・コメント・空行", () => {
    const input = [
      "ボルシャック・ドラゴン x4",
      "ナチュラル・トラップ ×3",
      "2x フェアリー・ライフ",
      "# コメント",
      "// コメント2",
      "",
      "デーモン・ハンド",
    ].join("\n");
    expect(parseDecklist(input)).toEqual({
      entries: [
        { count: 4, name: "ボルシャック・ドラゴン" },
        { count: 3, name: "ナチュラル・トラップ" },
        { count: 2, name: "フェアリー・ライフ" },
        { count: 1, name: "デーモン・ハンド" },
      ],
      totalCards: 10,
      errors: [],
    });
  });

  it("数字のみの行はエラー", () => {
    expect(parseDecklist("42")).toEqual({
      entries: [],
      totalCards: 0,
      errors: ['パースできない行: "42"'],
    });
  });

  it("空文字列", () => {
    expect(parseDecklist("")).toEqual({ entries: [], totalCards: 0, errors: [] });
  });
});
