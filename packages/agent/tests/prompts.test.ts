import { describe, it, expect } from "vitest";
import { SYSTEM_PROMPTS } from "../src/prompts.js";

describe("SYSTEM_PROMPTS", () => {
  it("全モードが定義されている", () => {
    expect(Object.keys(SYSTEM_PROMPTS).sort()).toEqual([
      "deck",
      "integrated",
      "meta",
      "rule",
    ]);
  });

  it("deck モードは評価/構築/改善のツール利用を明示する", () => {
    const p = SYSTEM_PROMPTS.deck;
    expect(p).toContain("evaluate_deck");
    expect(p).toContain("build_deck");
    expect(p).toContain("suggest_improvements");
    // ツールを必須化する規律が入っていること
    expect(p).toContain("必ず");
  });

  it("meta モードはティアツール利用を明示する", () => {
    expect(SYSTEM_PROMPTS.meta).toContain("get_tier_list");
    expect(SYSTEM_PROMPTS.meta).toContain("必ず");
  });

  it("integrated モードは主要ツールを網羅的に案内する", () => {
    const p = SYSTEM_PROMPTS.integrated;
    for (const tool of [
      "search_rules",
      "evaluate_deck",
      "build_deck",
      "suggest_improvements",
      "search_cards",
      "get_tier_list",
    ]) {
      expect(p).toContain(tool);
    }
  });

  it("全モードが捏造禁止の規律を含む(rule を除く)", () => {
    // rule は RAG 前提のため TOOL_DISCIPLINE を持たないが、deck/meta/integrated は捏造禁止を明示。
    for (const mode of ["deck", "meta", "integrated"] as const) {
      expect(SYSTEM_PROMPTS[mode]).toContain("捏造");
    }
  });
});
