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
  /**
   * 構築デッキの**数値**品質基準 (#140)。build_deck を呼ぶ問だけに付ける。
   *
   * LLM judge に品質判定を任せない ([[llm-judge-unreliable]])。エージェントが build_deck に
   * 渡した引数から deck-engine を呼び直し (autoBuild → scoreDeck)、得たデッキが基準を満たすかを
   * **機械的に**検証する。judge は「火文明中心か」「速攻の方針か」を言葉で見るだけだが、これは
   * 実際に組まれたデッキが火文明中心・低コスト・アグロ採点かを数値で見る。
   */
  expectedDeck?: DeckQualitySpec;
}

/**
 * 構築デッキの数値品質基準 (#140)。すべて任意 (指定した観点だけを検査する)。
 * 値は「エージェントが妥当な引数を渡せば deck-engine が達成できる水準」に置く
 * (ベースラインを実測してから margin を取って締める。THRESHOLDS と同じ運用)。
 */
export interface DeckQualitySpec {
  /** scoreDeck が推定すべきアーキタイプ (aggro/midrange/control/combo)。 */
  archetype?: string;
  /** 中心文明の内部コード (例 "fire")。構築デッキでこの文明が minCivShare 以上を占めること。 */
  civilization?: string;
  /** civilization の最低占有率 (0-1)。既定 0.5。 */
  minCivShare?: number;
  /** S・トリガーの最低枚数。 */
  minTrigger?: number;
  /** 低コスト(3以下)の最低枚数。 */
  minLowCost?: number;
  /** 総合スコアの最低値 (0-100)。 */
  minOverall?: number;
}

/** deckQuality に渡す、構築デッキから抽出した実測値 (#140)。 */
export interface DeckQualityStats {
  /** scoreDeck が推定したアーキタイプ。 */
  archetype?: string;
  /** S・トリガー枚数。 */
  triggerCount: number;
  /** 低コスト(3以下)の枚数 (costCurve.low)。 */
  lowCost: number;
  /** 総合スコア。 */
  overall: number;
  /** 文明コード → 占有率 (その文明のカード数 / 総枚数)。多色は各文明に計上。 */
  civShares: Record<string, number>;
  /** 総枚数。 */
  totalCards: number;
}

/** 構築デッキ品質の検証結果 (#140)。 */
export interface DeckQualityResult {
  passed: boolean;
  /** 満たさなかった基準の説明 (退行診断用)。空なら合格。 */
  failures: string[];
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
  /**
   * 構築デッキの数値品質 (#140)。expectedDeck を持つ問だけ計測する。
   * passed=false は「エージェントの引数が悪く、組まれたデッキが基準を満たさない」= 退行。
   */
  deckQuality?: DeckQualityResult;
  /**
   * 失敗したツール名 (#109)。**測らないものは直せない。**
   *
   * #112 では本番で全ツールが CONNECTION_ENDED で死んでいたのに、失敗が握り潰されていて
   * 「たまに調子が悪い」としか見えなかった。eval にも出していなかったので、
   * judge 4.94 のまま本番だけが壊れ続けた。
   */
  toolFailures?: string[];
  latencyMs: number;
  error?: string;
}
