import { describe, it, expect } from "vitest";
import { countMainCards, savedCardsToDecklist } from "../src/lib/deck-text.js";

describe("savedCardsToDecklist (QA②)", () => {
  it("メインは見出し無し、超次元・GR は見出しを付けて後ろに置く", () => {
    expect(
      savedCardsToDecklist([
        { count: 1, name: "H", zone: "hyperspatial" },
        { count: 4, name: "A" },
        { count: 2, name: "G", zone: "gr" },
        { count: 3, name: "B" },
      ]),
    ).toBe(["4 A", "3 B", "超次元ゾーン", "1 H", "GRゾーン", "2 G"].join("\n"));
  });

  it("zone の無い従来の保存データはそのまま並べる", () => {
    expect(savedCardsToDecklist([{ count: 4, name: "A" }])).toBe("4 A");
  });
});

describe("countMainCards (#179 / #165 B-05・B-07)", () => {
  it("見出しは数えず、超次元・GR の下の行はメインに入れない", () => {
    const text = [
      "メインデッキ",
      ...Array.from({ length: 10 }, (_, i) => `4 カード${i}`),
      "超次元ゾーン",
      "4 時空の英雄アンタッチャブル",
      "4 時空の喧嘩屋キル",
      "GRゾーン",
      "2 GRカード",
    ].join("\n");
    expect(countMainCards(text)).toBe(40);
  });

  it("全角数字・「枚」・末尾の ×N も枚数として数える。枚数なしは1枚", () => {
    expect(
      countMainCards(["４ A", "B 4枚", "C ×４", "D x2枚", "E", "# コメント", "42"].join("\n")),
    ).toBe(4 + 4 + 4 + 2 + 1);
  });

  it("超次元ミカド・ホール のようなカード名は見出しにしない", () => {
    expect(countMainCards("超次元ミカド・ホール\n超次元ゾーン\n1 H")).toBe(1);
  });
});
