import { describe, it, expect } from "vitest";
import { archetypeKey, canonicalizeArchetypes, mergeArchetypeCounts } from "../src/archetype.js";

describe("archetypeKey", () => {
  it("表記ゆれを吸収して同じキーにする", () => {
    const variants = [
      "アナカラージャオウガ",
      "アナカラー ジャオウガ",
      "アナカラー・ジャオウガ",
      "アナカラー　ジャオウガ", // 全角スペース
      "ｱﾅｶﾗｰｼﾞｬｵｳｶﾞ", // 半角カナ
    ];
    const keys = new Set(variants.map(archetypeKey));
    expect(keys.size).toBe(1);
  });

  it("英数字の大小・全半角を吸収する", () => {
    expect(archetypeKey("5cコントロール")).toBe(archetypeKey("５Ｃコントロール"));
    expect(archetypeKey("ラッカ鬼羅Star")).toBe(archetypeKey("ラッカ鬼羅star"));
  });

  it("デッキ名の装飾を落とす", () => {
    expect(archetypeKey("【アナカラージャオウガ】")).toBe(archetypeKey("アナカラージャオウガ"));
    expect(archetypeKey("赤緑アポロヌス(オリジナル)")).toBe(archetypeKey("赤緑アポロヌス"));
  });

  it("別デッキは別キーのままにする", () => {
    expect(archetypeKey("アナカラージャオウガ")).not.toBe(archetypeKey("アナカラー墓地退化"));
    expect(archetypeKey("赤単我我我")).not.toBe(archetypeKey("赤緑我我我"));
  });
});

describe("canonicalizeArchetypes", () => {
  it("同一キーの中で最頻の表記に寄せる", () => {
    const rows = [
      { deck_archetype: "アナカラージャオウガ", count: 10 },
      { deck_archetype: "アナカラー ジャオウガ", count: 3 },
      { deck_archetype: "赤緑アポロヌス", count: 5 },
    ];
    const result = canonicalizeArchetypes(rows);
    expect(result.get(archetypeKey("アナカラー ジャオウガ"))).toBe("アナカラージャオウガ");
    expect(result.get(archetypeKey("赤緑アポロヌス"))).toBe("赤緑アポロヌス");
  });

  it("出現数が同じなら短い表記を選ぶ (装飾の少ないほうを正とする)", () => {
    const rows = [
      { deck_archetype: "アナカラー ジャオウガ", count: 4 },
      { deck_archetype: "アナカラージャオウガ", count: 4 },
    ];
    const result = canonicalizeArchetypes(rows);
    expect(result.get(archetypeKey("アナカラージャオウガ"))).toBe("アナカラージャオウガ");
  });

  it("空配列でも落ちない", () => {
    expect(canonicalizeArchetypes([]).size).toBe(0);
  });
});

describe("mergeArchetypeCounts", () => {
  it("表記ゆれを1行にまとめて出現数を合算する", () => {
    const merged = mergeArchetypeCounts([
      { deck_archetype: "アナカラージャオウガ", count: 10 },
      { deck_archetype: "アナカラー ジャオウガ", count: 3 },
      { deck_archetype: "【アナカラージャオウガ】", count: 2 },
      { deck_archetype: "赤緑アポロヌス", count: 6 },
    ]);
    expect(merged).toEqual([
      { deck_archetype: "アナカラージャオウガ", count: 15 },
      { deck_archetype: "赤緑アポロヌス", count: 6 },
    ]);
  });

  it("出現数の降順に並べる", () => {
    const merged = mergeArchetypeCounts([
      { deck_archetype: "青黒魔導具", count: 2 },
      { deck_archetype: "赤単我我我", count: 9 },
    ]);
    expect(merged.map((r) => r.deck_archetype)).toEqual(["赤単我我我", "青黒魔導具"]);
  });

  it("postgres の COUNT が文字列で返っても合算できる", () => {
    const merged = mergeArchetypeCounts([
      { deck_archetype: "5cコントロール", count: "4" },
      { deck_archetype: "５Ｃコントロール", count: "1" },
    ]);
    expect(merged).toEqual([{ deck_archetype: "5cコントロール", count: 5 }]);
  });

  it("名前が装飾だけで空になる行は捨てる", () => {
    const merged = mergeArchetypeCounts([
      { deck_archetype: "【】", count: 3 },
      { deck_archetype: "赤単我我我", count: 1 },
    ]);
    expect(merged).toEqual([{ deck_archetype: "赤単我我我", count: 1 }]);
  });
});
