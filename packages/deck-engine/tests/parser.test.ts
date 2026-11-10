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

describe("parseDecklist 枚数の書き方 (#165 B-05)", () => {
  it.each([
    ["４ ボルシャック・ドラゴン", 4],
    ["4枚 ボルシャック・ドラゴン", 4],
    ["４枚　ボルシャック・ドラゴン", 4],
    ["ボルシャック・ドラゴン 4枚", 4],
    ["ボルシャック・ドラゴン　４枚", 4],
    ["ボルシャック・ドラゴン ×４", 4],
    ["ボルシャック・ドラゴン x4枚", 4],
    ["ボルシャック・ドラゴン ｘ3", 3],
    ["ボルシャック・ドラゴン Ｘ２", 2],
    ["ボルシャック・ドラゴン *4", 4],
    ["12 x ボルシャック・ドラゴン", 12],
  ])("「%s」は %i 枚", (line, count) => {
    expect(parseDecklist(line).entries).toEqual([{ count, name: "ボルシャック・ドラゴン" }]);
  });

  it("カード名の全角文字はそのまま残す (DB と完全一致で引くため NFKC をかけない)", () => {
    expect(parseDecklist("４ ＧＲ召喚テスト").entries).toEqual([
      { count: 4, name: "ＧＲ召喚テスト" },
    ]);
  });

  it("「枚」の無い末尾の数字は枚数と読まない (数字で終わるカード名を壊さない)", () => {
    expect(parseDecklist("テストカード 2").entries).toEqual([{ count: 1, name: "テストカード 2" }]);
  });

  it("全角数字だけの行は読めない行として返す (#165 B-06)", () => {
    expect(parseDecklist("４２")).toMatchObject({
      entries: [],
      errors: ['パースできない行: "４２"'],
    });
  });
});

describe("parseDecklist #179 の再現手順", () => {
  it("Issue #179 の入力: 見出しは数えず、超次元は本体と別枠", () => {
    const parsed = parseDecklist(
      [
        "メインデッキ",
        "4 ボルシャック・ドラゴン",
        "超次元ゾーン",
        "1 時空の英雄アンタッチャブル",
      ].join("\n"),
    );
    expect(parsed.entries).toEqual([{ count: 4, name: "ボルシャック・ドラゴン" }]);
    expect(parsed.totalCards).toBe(4);
    expect(parsed.zones?.hyperspatial).toEqual([{ count: 1, name: "時空の英雄アンタッチャブル" }]);
    expect(parsed.errors).toEqual([]);
  });

  it("Issue #165 の入力 (全角数字・「枚」・見出し・超次元の混在)", () => {
    const parsed = parseDecklist(
      [
        "メインデッキ",
        "４ ボルシャック・ドラゴン",
        "ボルシャック・ドラゴン 4枚",
        "超次元ゾーン",
        "1 時空の英雄アンタッチャブル",
      ].join("\n"),
    );
    expect(parsed.entries).toEqual([
      { count: 4, name: "ボルシャック・ドラゴン" },
      { count: 4, name: "ボルシャック・ドラゴン" },
    ]);
    expect(parsed.totalCards).toBe(8);
    expect(parsed.zones?.hyperspatial).toEqual([{ count: 1, name: "時空の英雄アンタッチャブル" }]);
  });

  it("超次元ゾーンの見出しに全角の枚数が付いていても見出しとして扱う", () => {
    expect(detectZoneHeading("【超次元ゾーン ８枚】")).toBe("hyperspatial");
  });
});
