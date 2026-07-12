import { describe, it, expect } from "vitest";
import { partitionByRule, type TaggingCard } from "../src/tag-partition.js";

function tc(overrides: Partial<TaggingCard>): TaggingCard {
  return {
    id: 1,
    name: "x",
    cost: 5,
    text: "",
    power: null,
    is_shield_trigger: false,
    ...overrides,
  };
}

describe("partitionByRule", () => {
  it("ルールでタグが付くカードは ruleTagged、付かないカードは needsLlm", () => {
    const cards = [
      tc({ id: 1, is_shield_trigger: true }), // 受け → ruleTagged
      tc({ id: 2, cost: 5, text: "" }), // バニラ → needsLlm
      tc({ id: 3, cost: 2, text: "カードを2枚引く。" }), // ドロー+初動 → ruleTagged
    ];
    const { ruleTagged, needsLlm } = partitionByRule(cards);
    expect(ruleTagged.map((r) => r.id).sort()).toEqual([1, 3]);
    expect(needsLlm.map((c) => c.id)).toEqual([2]);
    expect(ruleTagged.find((r) => r.id === 1)!.tags).toContain("受け");
  });

  it("全カードがルールで付く場合 needsLlm は空", () => {
    const { needsLlm } = partitionByRule([tc({ id: 1, is_shield_trigger: true })]);
    expect(needsLlm).toEqual([]);
  });
});
