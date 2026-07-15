import { describe, it, expect } from "vitest";
import { aggregateTierData } from "../src/meta.js";
import { TIER_BELOW } from "../src/constants.js";

/**
 * ティア分類 (#132)。
 *
 * 旧実装は固定閾値 (使用率 15% / 8%) の3段だった。ところが使用率はシェア (入賞数/母数) なので
 * 「1〜2強 + ロングテール」という DM の分布では 8-15% の中間帯が構造的に空き、Tier1 と Tier3 しか
 * 出なかった。閾値を細分化しても中間帯が空く問題は解決しない。
 *
 * 新実装は**相対分類**: 使用率降順に並べ、有意アーキタイプを順位で5分位に割り当てる。
 * これにより有意アーキタイプが5種以上あれば Tier1〜5 のどの中間段も空かない。
 * 単発入賞のロングテール (使用率 < 2% または 入賞 < 2件) は「その他」へ落とす。
 */

describe("aggregateTierData (相対分類 #132)", () => {
  it("有意アーキタイプが5種以上あれば Tier1〜5 のどの中間段も空かない", () => {
    // 10 アーキタイプ。使用率降順。すべて 2%・2件以上。
    const results = [
      { deck_archetype: "A", count: 20 },
      { deck_archetype: "B", count: 18 },
      { deck_archetype: "C", count: 16 },
      { deck_archetype: "D", count: 14 },
      { deck_archetype: "E", count: 12 },
      { deck_archetype: "F", count: 10 },
      { deck_archetype: "G", count: 8 },
      { deck_archetype: "H", count: 6 },
      { deck_archetype: "I", count: 4 },
      { deck_archetype: "J", count: 3 },
    ];
    const out = aggregateTierData(results);
    // 使用率降順で 5分位: {A,B}=1 {C,D}=2 {E,F}=3 {G,H}=4 {I,J}=5
    const tierOf = (a: string) => out.find((e) => e.archetype === a)!.tier;
    expect(tierOf("A")).toBe("Tier1");
    expect(tierOf("B")).toBe("Tier1");
    expect(tierOf("C")).toBe("Tier2");
    expect(tierOf("E")).toBe("Tier3");
    expect(tierOf("G")).toBe("Tier4");
    expect(tierOf("J")).toBe("Tier5");
    // どの段も空でない
    const tiers = new Set(out.map((e) => e.tier));
    for (const t of ["Tier1", "Tier2", "Tier3", "Tier4", "Tier5"]) {
      expect(tiers.has(t)).toBe(true);
    }
  });

  it("使用率 < 2% のアーキタイプは「その他」へ落とす (入賞数は 2 以上でも)", () => {
    // 母数が大きいので count=2 でも使用率 < 2%
    const results = [
      { deck_archetype: "Big", count: 200 },
      { deck_archetype: "Tiny", count: 2 },
    ];
    const out = aggregateTierData(results);
    expect(out.find((e) => e.archetype === "Big")!.tier).toBe("Tier1");
    expect(out.find((e) => e.archetype === "Tiny")!.tier).toBe(TIER_BELOW);
  });

  it("入賞 < 2件 のアーキタイプは「その他」へ落とす (使用率が高くても)", () => {
    // 母数が小さく、1件でも使用率は高い。だが単発入賞は段に混ぜない。
    const results = [
      { deck_archetype: "A", count: 5 },
      { deck_archetype: "B", count: 3 },
      { deck_archetype: "Single", count: 1 }, // 1/9 = 11% だが 1件
    ];
    const out = aggregateTierData(results);
    expect(out.find((e) => e.archetype === "Single")!.tier).toBe(TIER_BELOW);
    // 有意は A,B の 2種 → M<=5 なので順に Tier1, Tier2
    expect(out.find((e) => e.archetype === "A")!.tier).toBe("Tier1");
    expect(out.find((e) => e.archetype === "B")!.tier).toBe("Tier2");
  });

  it("有意アーキタイプが5種以下なら上から Tier1,2,3... と連番で埋める (段飛びしない)", () => {
    const results = [
      { deck_archetype: "A", count: 10 },
      { deck_archetype: "B", count: 8 },
      { deck_archetype: "C", count: 6 },
    ];
    const out = aggregateTierData(results);
    expect(out.map((e) => e.tier)).toEqual(["Tier1", "Tier2", "Tier3"]);
  });

  it("呼び出し側のソート順に依存せず、内部で使用率降順に整列してから割り当てる", () => {
    const results = [
      { deck_archetype: "A", count: 3 },
      { deck_archetype: "B", count: 10 },
      { deck_archetype: "C", count: 6 },
    ];
    const out = aggregateTierData(results);
    // 出力は使用率降順
    expect(out.map((e) => e.archetype)).toEqual(["B", "C", "A"]);
    expect(out[0]).toMatchObject({ archetype: "B", tier: "Tier1" });
    expect(out[2]).toMatchObject({ archetype: "A", tier: "Tier3" });
  });

  it("usage_rate を丸め、勝率は返さず入賞数を返す (#122)", () => {
    const results = [
      { deck_archetype: "A", count: 6 },
      { deck_archetype: "B", count: 2 },
    ];
    const out = aggregateTierData(results);
    expect(out[0]).toMatchObject({ archetype: "A", usage_rate: 75, entries: 6, total_entries: 8 });
    expect(out[1]).toMatchObject({ archetype: "B", usage_rate: 25, entries: 2 });
    expect(out[0]).not.toHaveProperty("win_rate");
    expect(out[0]).not.toHaveProperty("sample_decklist");
  });

  it("COUNT が文字列でも数値として集計する (postgres.js 対策)", () => {
    const results = [
      { deck_archetype: "A", count: "6" },
      { deck_archetype: "B", count: "2" },
    ];
    const out = aggregateTierData(results);
    expect(out[0].usage_rate).toBe(75);
    expect(out[1].usage_rate).toBe(25);
  });

  it("空入力は空配列を返す", () => {
    expect(aggregateTierData([])).toEqual([]);
  });
});
