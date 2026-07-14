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

/**
 * 実測した hybridSearch の top スコア。
 *
 * **これは「ルール質問 vs デッキ質問」の分類器ではない。** ルールの語彙を使ったデッキ質問は
 * 閾値を超える (下の GRAY_ZONE)。分けているのは「DM のルールに触れるか / 触れないか」で、
 * 境界の余裕は 0.689〜0.733 の 0.04 しかない。この事実を数値として固定しておく。
 */
const MEASURED_RULE_TOPS = [0.852, 0.807, 0.854, 0.838, 0.764, 0.897, 0.903];

/** ルールに触れない質問。カード検索 (0.688) と遊戯王 (0.689) は閾値まで 0.012 しかない。 */
const MEASURED_OFF_TOPIC_TOPS = [0.645, 0.688, 0.579, 0.689];

/**
 * ルールの語彙を使ったデッキ質問。**閾値を超えて条文が積まれる。**
 * 拾いすぎだが無害 — 話題として妥当な条文であり、前置きも「関係なければ無視してよい」と伝える。
 * eval でも integrated-deck-build は judge=5 でツールを呼び、構築を拒否していない。
 */
const MEASURED_GRAY_ZONE_TOPS = [0.768, 0.759, 0.739, 0.733];

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

  it("ルールに触れない質問 (カード検索・ティア・遊戯王) は捨てられる", () => {
    for (const top of MEASURED_OFF_TOPIC_TOPS) {
      expect(acceptsRagResult("integrated", [{ score: top }])).toBe(false);
    }
  });

  it("ルール語彙を使ったデッキ質問は拾ってしまう (既知の拾いすぎ。無害と判断した)", () => {
    // **この足切りはルール質問とデッキ質問を分けられない。** それを隠さず固定しておく。
    // 拾った条文は話題として妥当で、前置きが「関係なければ無視してよい」と伝える。
    for (const top of MEASURED_GRAY_ZONE_TOPS) {
      expect(acceptsRagResult("integrated", [{ score: top }])).toBe(true);
    }
  });

  it("境界の余裕は 0.04 しかない (埋め込みの揺れで反転しうる)", () => {
    const offTopicMax = Math.max(...MEASURED_OFF_TOPIC_TOPS); // 0.689 (遊戯王)
    const grayMin = Math.min(...MEASURED_GRAY_ZONE_TOPS); // 0.733 (ブロッカー多めのデッキ)
    expect(INTEGRATED_RAG_MIN_SCORE).toBeGreaterThan(offTopicMax);
    expect(INTEGRATED_RAG_MIN_SCORE).toBeLessThan(grayMin);
    // 谷は狭い。0.70 は「安全な中点」ではなく「取りこぼしより拾いすぎを選んだ値」。
    expect(grayMin - offTopicMax).toBeLessThan(0.05);
  });

  it("ルール質問は取りこぼさない (取りこぼしの方が害が大きい)", () => {
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
