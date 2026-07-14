import { describe, it, expect } from "vitest";
import {
  acceptsRagResult,
  buildSystemPrompt,
  INTEGRATED_RAG_MIN_SCORE,
  RAG_CONTEXT_HEADER,
  INTEGRATED_RAG_CONTEXT_HEADER,
} from "../src/graph.js";
import type { AgentStateType } from "../src/state.js";

/**
 * integrated モードの事前 RAG (#108)。
 *
 * **web の既定モードは integrated。** ところがグラフの分岐は rule だけを retrieve に通しており、
 * integrated で search_rules を呼ぶかは LLM 任せだった。呼ばなければ根拠ゼロで答える
 * (本番実測: ルール質問8問中1問がツール未使用・引用0件)。
 *
 * ここでは「integrated でも条文を取りに行く」ことと、「ルールと無関係な質問には条文を積まない」
 * ことの両方を検証する。閾値は実測に基づく (下の分布コメントを参照)。
 */

/** 実測した hybridSearch の top スコア。閾値がこの2群を正しく分けることを固定する。 */
const MEASURED_RULE_TOPS = [0.852, 0.807, 0.854, 0.838, 0.764, 0.897];
const MEASURED_NON_RULE_TOPS = [0.611, 0.616, 0.576, 0.674, 0.625];

const state = (over: Partial<AgentStateType>): AgentStateType =>
  ({
    messages: [],
    mode: "integrated",
    format: undefined,
    ragContext: undefined,
    citations: [],
    iterations: 0,
    ...over,
  }) as AgentStateType;

describe("acceptsRagResult (integrated の足切り)", () => {
  it("実測したルール質問のスコアは全て採用される", () => {
    for (const top of MEASURED_RULE_TOPS) {
      expect(acceptsRagResult("integrated", [{ score: top }])).toBe(true);
    }
  });

  it("実測した非ルール質問のスコアは全て捨てられる", () => {
    // デッキ構築の質問に無関係な条文と出典が付くのを防ぐ。
    for (const top of MEASURED_NON_RULE_TOPS) {
      expect(acceptsRagResult("integrated", [{ score: top }])).toBe(false);
    }
  });

  it("閾値は実測の谷 (0.674 〜 0.764) の内側にある", () => {
    expect(INTEGRATED_RAG_MIN_SCORE).toBeGreaterThan(Math.max(...MEASURED_NON_RULE_TOPS));
    expect(INTEGRATED_RAG_MIN_SCORE).toBeLessThan(Math.min(...MEASURED_RULE_TOPS));
  });

  it("rule モードはスコアに関わらず採用する (利用者が明示的にルールを聞いている)", () => {
    expect(acceptsRagResult("rule", [{ score: 0.1 }])).toBe(true);
  });

  it("ヒット0件なら採用しない", () => {
    expect(acceptsRagResult("rule", [])).toBe(false);
    expect(acceptsRagResult("integrated", [])).toBe(false);
  });

  it("最大スコアで判定する (並び順に依存しない)", () => {
    const chunks = [{ score: 0.3 }, { score: 0.9 }, { score: 0.5 }];
    expect(acceptsRagResult("integrated", chunks)).toBe(true);
  });
});

describe("buildSystemPrompt (RAG 前置きの出し分け)", () => {
  it("integrated には rule 用の強い前置きを使わない", () => {
    // rule 用は「資料に無いことは分からないと述べてください」と書いてある。これを integrated に
    // 付けると、デッキ構築の質問に「資料に無いので分かりません」と答えかねない。
    const msg = buildSystemPrompt(state({ mode: "integrated", ragContext: "[1] 【総合ルール】…" }));
    const text = msg.content as string;
    expect(text).toContain(INTEGRATED_RAG_CONTEXT_HEADER);
    expect(text).not.toContain(RAG_CONTEXT_HEADER);
    // デッキ構築など無関係な質問では無視してよいと明示していること
    expect(text).toContain("無視して構いません");
  });

  it("rule には従来の強い前置きを使う", () => {
    const msg = buildSystemPrompt(state({ mode: "rule", ragContext: "[1] 【総合ルール】…" }));
    expect(msg.content as string).toContain(RAG_CONTEXT_HEADER);
  });

  it("RAG が無ければ前置きを付けない", () => {
    const msg = buildSystemPrompt(state({ mode: "integrated", ragContext: undefined }));
    const text = msg.content as string;
    expect(text).not.toContain(INTEGRATED_RAG_CONTEXT_HEADER);
    expect(text).not.toContain(RAG_CONTEXT_HEADER);
  });
});
