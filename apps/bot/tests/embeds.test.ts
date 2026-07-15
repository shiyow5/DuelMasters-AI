import { describe, it, expect } from "vitest";
import { tierEmbed, type TierEntry } from "../src/interactions/embeds.js";

/**
 * ティア表 embed (#132)。
 *
 * ループ対象を固定配列 `["Tier1","Tier2","Tier3"]` から `[...MAIN_TIERS, TIER_BELOW]`
 * (Tier1〜5 + その他) に変えたので、5段+その他が段ごとに出て、空の段はスキップされることを固定する。
 */
describe("tierEmbed (#132)", () => {
  const e = (tier: string, archetype: string, usage_rate: number): TierEntry => ({
    tier,
    archetype,
    usage_rate,
  });

  it("Tier1〜5 + その他 を段順にフィールド化する", () => {
    const data = [
      e("Tier1", "A", 30),
      e("Tier2", "B", 20),
      e("Tier3", "C", 12),
      e("Tier4", "D", 8),
      e("Tier5", "E", 4),
      e("その他", "F", 1),
    ];
    const embed = tierEmbed("original", data);
    expect(embed.fields?.map((f) => f.name)).toEqual([
      "Tier1",
      "Tier2",
      "Tier3",
      "Tier4",
      "Tier5",
      "その他",
    ]);
    // 値は "**アーキタイプ** (使用率%)"
    expect(embed.fields?.[0].value).toContain("**A** (30%)");
    expect(embed.fields?.[5].value).toContain("**F** (1%)");
  });

  it("エントリの無い段はフィールドにしない", () => {
    // Tier1 と Tier5 だけにデータがある (中間は空)
    const data = [e("Tier1", "A", 40), e("Tier5", "B", 3)];
    const embed = tierEmbed("advance", data);
    expect(embed.fields?.map((f) => f.name)).toEqual(["Tier1", "Tier5"]);
  });

  it("同じ段の複数アーキタイプを1フィールドにまとめる", () => {
    const data = [e("Tier1", "A", 30), e("Tier1", "B", 25)];
    const embed = tierEmbed("original", data);
    expect(embed.fields).toHaveLength(1);
    expect(embed.fields?.[0].value).toBe("**A** (30%)\n**B** (25%)");
  });

  it("データが空なら fields を持たない", () => {
    const embed = tierEmbed("original", []);
    expect(embed.fields).toBeUndefined();
  });
});
