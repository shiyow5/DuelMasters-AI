import { describe, it, expect } from "vitest";
import {
  prScore,
  toolTrajectory,
  citationScore,
  factCoverage,
  aggregate,
} from "../eval/metrics.js";

describe("prScore", () => {
  it("完全一致で precision=recall=1", () => {
    const r = prScore(["a", "b"], ["a", "b"]);
    expect(r).toMatchObject({ matched: 2, recall: 1, precision: 1 });
  });
  it("一部一致", () => {
    const r = prScore(["a", "b"], ["a", "c"]);
    expect(r.recall).toBe(0.5); // 2 中 1
    expect(r.precision).toBe(0.5); // 2 中 1
  });
  it("expected 空は recall=1 (問わない)", () => {
    expect(prScore([], ["a"]).recall).toBe(1);
  });
  it("actual 空は precision=1 (誤検出なし)", () => {
    expect(prScore(["a"], []).precision).toBe(1);
    expect(prScore(["a"], []).recall).toBe(0);
  });
});

describe("toolTrajectory", () => {
  it("期待ツールが呼ばれていれば recall=1", () => {
    expect(toolTrajectory(["search_rules"], ["search_rules", "search_cards"]).recall).toBe(1);
  });
  it("期待ツール未呼び出しは recall=0", () => {
    expect(toolTrajectory(["evaluate_deck"], ["search_cards"]).recall).toBe(0);
  });
});

describe("citationScore", () => {
  it("citations の article を照合する", () => {
    const cites = [
      { article: "1234.5", text: "x" },
      { article: "9999", text: "y" },
    ];
    const r = citationScore(["1234.5"], cites);
    expect(r.recall).toBe(1);
    expect(r.matched).toBe(1);
  });
  it("数値 article も文字列化して照合", () => {
    expect(citationScore(["100"], [{ article: 100 }]).recall).toBe(1);
  });
  it("article 無し citation は無視", () => {
    expect(citationScore(["1"], [{ text: "no article" }]).recall).toBe(0);
  });
});

describe("factCoverage", () => {
  it("要点が含まれる割合 (空白・大小無視)", () => {
    expect(factCoverage(["S トリガー", "ブロック"], "Sトリガーはブロックされない")).toBe(1);
    expect(factCoverage(["A", "B"], "Aだけ")).toBe(0.5);
  });
  it("expected 空は 1", () => {
    expect(factCoverage([], "何でも")).toBe(1);
  });
});

describe("aggregate", () => {
  it("存在する指標のみ平均、error は除外", () => {
    const agg = aggregate([
      { tool: prScore(["a"], ["a"]), citation: prScore(["x"], ["x"]), judgeScore: 4 },
      { tool: prScore(["a"], []), judgeScore: 2 },
      { error: "boom" },
    ]);
    expect(agg.n).toBe(3);
    expect(agg.errors).toBe(1);
    expect(agg.toolRecall).toBe(0.5); // (1 + 0) / 2
    expect(agg.citationRecall).toBe(1); // 1 件のみ
    expect(agg.judgeMean).toBe(3); // (4 + 2) / 2
    expect(agg.factCoverage).toBeNull(); // 該当なし
  });
});
