import { describe, it, expect } from "vitest";
import { parseDecklist, detectZoneHeading } from "../src/parser.js";

describe("parseDecklist 特性テスト", () => {
  it("『4 カード名』形式", () => {
    expect(parseDecklist("4 ボルシャック・ドラゴン")).toEqual({
      entries: [{ count: 4, name: "ボルシャック・ドラゴン" }],
      totalCards: 4,
      errors: [],
      zones: { hyperspatial: [], gr: [] },
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
      zones: { hyperspatial: [], gr: [] },
    });
  });

  it("数字のみの行はエラー", () => {
    expect(parseDecklist("42")).toEqual({
      entries: [],
      totalCards: 0,
      errors: ['パースできない行: "42"'],
      zones: { hyperspatial: [], gr: [] },
    });
  });

  it("空文字列", () => {
    expect(parseDecklist("")).toEqual({
      entries: [],
      totalCards: 0,
      errors: [],
      zones: { hyperspatial: [], gr: [] },
    });
  });
});

describe("parseDecklist ゾーン見出し (QA② / #165 B-07)", () => {
  it("見出し行はカードとして数えず、超次元・GR はメインと別に分ける", () => {
    const input = [
      "メインデッキ",
      "4 ボルシャック・ドラゴン",
      "4 ナチュラル・トラップ",
      "超次元ゾーン",
      "1 時空の英雄アンタッチャブル",
      "2 時空の喧嘩屋キル",
      "GRゾーン",
      "2 ジェイ-SHOCKER",
    ].join("\n");
    expect(parseDecklist(input)).toEqual({
      entries: [
        { count: 4, name: "ボルシャック・ドラゴン" },
        { count: 4, name: "ナチュラル・トラップ" },
      ],
      totalCards: 8,
      errors: [],
      zones: {
        hyperspatial: [
          { count: 1, name: "時空の英雄アンタッチャブル" },
          { count: 2, name: "時空の喧嘩屋キル" },
        ],
        gr: [{ count: 2, name: "ジェイ-SHOCKER" }],
      },
    });
  });

  it.each([
    ["メインデッキ", "main"],
    ["【メインデッキ】", "main"],
    ["メインデッキ (40枚)", "main"],
    ["■超次元ゾーン", "hyperspatial"],
    ["超次元ゾーン：8枚", "hyperspatial"],
    ["超次元", "hyperspatial"],
    ["GRゾーン", "gr"],
    ["ＧＲゾーン（12枚）", "gr"],
    ["超GR", "gr"],
    ["[GR] 12", "gr"],
  ] as const)("見出し %s → %s", (line, zone) => {
    expect(detectZoneHeading(line)).toBe(zone);
  });

  it.each([
    "4 超次元ミカド・ホール",
    "超次元ミカド・ホール",
    "GRレッド・ドラゴン",
    "ボルシャック・ドラゴン",
  ])("カード名 %s は見出しにしない", (line) => {
    expect(detectZoneHeading(line)).toBeNull();
  });

  it("見出しより前の行はメインデッキに入る", () => {
    const parsed = parseDecklist(["4 A", "超次元ゾーン", "1 B"].join("\n"));
    expect(parsed.entries).toEqual([{ count: 4, name: "A" }]);
    expect(parsed.totalCards).toBe(4);
    expect(parsed.zones?.hyperspatial).toEqual([{ count: 1, name: "B" }]);
  });
});
