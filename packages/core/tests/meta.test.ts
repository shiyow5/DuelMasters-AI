import { describe, it, expect } from "vitest";
import { aggregateTierData } from "../src/meta.js";

describe("aggregateTierData", () => {
  it("使用率から Tier1/2/3 を判定し usage_rate を丸める", () => {
    const results = [
      { deck_archetype: "A", count: 6 },
      { deck_archetype: "B", count: 3 },
      { deck_archetype: "C", count: 1 },
    ];
    const out = aggregateTierData(results);
    expect(out[0]).toMatchObject({
      archetype: "A",
      tier: "Tier1",
      usage_rate: 60,
    });
    expect(out[1]).toMatchObject({
      archetype: "B",
      tier: "Tier1",
      usage_rate: 30,
    });
    expect(out[2]).toMatchObject({
      archetype: "C",
      tier: "Tier2",
      usage_rate: 10,
    });
    // **勝率は返さない** (#122)。取込元に勝敗が無く、原理的に計算できない。
    // 代わりに実データで裏付けられる入賞数を返す。
    expect(out[0]).not.toHaveProperty("win_rate");
    expect(out[0].entries).toBeGreaterThan(0);
    expect(out[0].total_entries).toBeGreaterThan(0);
  });

  it("COUNT が文字列でも数値として集計する (postgres.js 対策)", () => {
    const results = [
      { deck_archetype: "A", count: "3" },
      { deck_archetype: "B", count: "1" },
    ];
    const out = aggregateTierData(results);
    expect(out[0].usage_rate).toBe(75);
    expect(out[1].usage_rate).toBe(25);
  });
});
