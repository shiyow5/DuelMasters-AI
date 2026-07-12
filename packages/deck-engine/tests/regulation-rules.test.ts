import { describe, it, expect } from "vitest";
import { classifyRegulations, applyRegulationToRequired } from "../src/regulation-rules.js";

describe("classifyRegulations", () => {
  it("3種の restriction_type を banned/limited に分類し、コンビは除外", () => {
    const reg = classifyRegulations([
      { card_name: "禁止A", restriction_type: "プレミアム殿堂" },
      { card_name: "制限B", restriction_type: "殿堂入り" },
      { card_name: "コンビC", restriction_type: "プレミアム殿堂コンビ" },
    ]);
    expect(reg.banned.has("禁止A")).toBe(true);
    expect(reg.limited.has("制限B")).toBe(true);
    expect(reg.banned.has("コンビC")).toBe(false);
    expect(reg.limited.has("コンビC")).toBe(false);
  });
});

describe("applyRegulationToRequired", () => {
  const reg = classifyRegulations([
    { card_name: "禁止A", restriction_type: "プレミアム殿堂" },
    { card_name: "制限B", restriction_type: "殿堂入り" },
  ]);

  it("banned は不採用+警告、limited は count 1、通常は count 4", () => {
    const { adopted, warnings } = applyRegulationToRequired(["禁止A", "制限B", "通常C"], reg);
    expect(adopted).toEqual([
      { name: "制限B", count: 1 },
      { name: "通常C", count: 4 },
    ]);
    expect(warnings).toEqual(["「禁止A」はプレミアム殿堂のため採用できません"]);
  });

  it("空配列は空結果", () => {
    expect(applyRegulationToRequired([], reg)).toEqual({
      adopted: [],
      warnings: [],
    });
  });
});
