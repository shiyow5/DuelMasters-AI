import { describe, it, expect } from "vitest";
import { SYSTEM_PROMPTS } from "../src/prompts.js";

describe("SYSTEM_PROMPTS", () => {
  it("全モードが定義されている", () => {
    expect(Object.keys(SYSTEM_PROMPTS).sort()).toEqual(["deck", "integrated", "meta", "rule"]);
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

  describe("出典の明記 (#99)", () => {
    // 出典の指示は rule モードにしか無かった。web の既定は **integrated** なので、
    // ルールを聞いても出典が求められていなかった。全モードに入れる。
    it("全モードが出典の規律を含む", () => {
      for (const mode of ["rule", "deck", "meta", "integrated"] as const) {
        expect(SYSTEM_PROMPTS[mode]).toContain("出典");
      }
    });

    it("全モードが条番号込みの出典形式を指示する", () => {
      // 「引用しながら」だけでは条番号が出ない。RAG が渡すのと同じ形を指定する。
      for (const mode of ["rule", "deck", "meta", "integrated"] as const) {
        expect(SYSTEM_PROMPTS[mode]).toContain("【総合ルール");
      }
    });

    it("全モードが「資料に無い条番号を書くな」と明示する", () => {
      // **これが要**。LLM は実在しない条番号を平然と書く (#92 で 701.29a / 116.3a を捏造した)。
      // 「記憶している条番号」ではなく「渡された資料に出てきた条番号」だけを写させる。
      for (const mode of ["rule", "deck", "meta", "integrated"] as const) {
        expect(SYSTEM_PROMPTS[mode]).toMatch(/参考資料に(出てこない|無い|ない)条番号/);
        expect(SYSTEM_PROMPTS[mode]).toContain("でっち上げ");
      }
    });

    it("全モードが一次情報 (総合ルール) を優先させる", () => {
      // 【裁定Q&A】には改定前の古い回答が混じる (#92)。食い違ったら条文を採らせる。
      for (const mode of ["rule", "deck", "meta", "integrated"] as const) {
        expect(SYSTEM_PROMPTS[mode]).toContain("裁定Q&A");
      }
    });
  });
});
