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
    expect(out[0].win_rate).toBeNull();
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
