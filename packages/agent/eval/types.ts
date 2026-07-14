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
  /**
   * 根拠 (引用 or ツール結果) が必ず付くべき問か (#108)。
   *
   * **ツールを呼んだかでは測れない。** 事前 RAG (retrieve) が条文を渡すと、モデルは
   * search_rules を呼ばずに答える。それは正しい振る舞いなのに toolRecall は 0 になる。
   * 逆に「ツールも呼ばず引用も無い」= 記憶だけで答えた状態が #108 の害そのものなので、
   * **引用かツールのどちらかがあること**を測る。
   *
   * 遊戯王の質問のように「根拠なしで断るのが正解」の問には付けない。
   */
  expectEvidence?: boolean;
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
  /** 本文に書いた条番号が retrieve した資料にあった割合 (#99)。引用なしは null。 */
  citationGrounding?: number | null;
  factCoverage?: number;
  judgeScore?: number;
  judgeReason?: string;
  /** judge を回したが失敗した (quota/スキーマ/キー不正)。部分障害の検出に使う。 */
  judgeFailed?: boolean;
  /**
   * 回答本文。**退行の診断に要る。**
   * これが無いと「factCoverage が 1.00 → 0.00 に落ちた」と分かっても、なぜ落ちたのかを
   * レポートから追えず、毎回 eval を回し直すことになる (実際にそうなった)。
   */
  response?: string;
  /** 引いた条番号 (本文から抽出したもの)。捏造した番号を目で確認できるようにする。 */
  citedArticles?: string[];
  /** 資料に無く、本文から落とした条番号 (= agent がでっち上げた番号)。 */
  ungroundedCitations?: string[];
  /**
   * 根拠 (引用 or ツール呼び出し) が付いたか (#108)。expectEvidence の問だけ計測する。
   * false = 記憶だけで答えた = ハルシネーションの温床。
   */
  hasEvidence?: boolean;
  latencyMs: number;
  error?: string;
}
