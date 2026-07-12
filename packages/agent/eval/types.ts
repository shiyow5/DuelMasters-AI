import type { AgentMode } from "../src/state.js";

/**
 * golden set の1問。正解データは「私が起案 → ユーザーがレビュー」で確定する。
 * expectedCitations / expectedTools / expectedFacts は任意 (問題種別で使い分ける)。
 */
export interface GoldenItem {
  id: string;
  question: string;
  mode: AgentMode;
  format?: "original" | "advance";
  /** 呼ばれるべきツール名 (ツール軌跡の評価用) */
  expectedTools?: string[];
  /** 引用されるべきルール条番号など (引用照合用) */
  expectedCitations?: string[];
  /** 回答に含まれるべき要点 (事実カバレッジ用) */
  expectedFacts?: string[];
  /** 開放問の採点基準 (LLM-as-judge 用) */
  rubric?: string;
  /** マルチターン用の会話履歴 */
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}

/** precision / recall のペア (該当なし時は 1 とみなす方針は算出側で明示)。 */
export interface PR {
  precision: number;
  recall: number;
  matched: number;
  expected: number;
  actual: number;
}

/** 1問の評価結果。 */
export interface ItemResult {
  id: string;
  mode: AgentMode;
  tool?: PR;
  citation?: PR;
  factCoverage?: number;
  judgeScore?: number;
  judgeReason?: string;
  latencyMs: number;
  error?: string;
}
