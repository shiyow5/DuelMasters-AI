import { Annotation, MessagesAnnotation } from "@langchain/langgraph";

export type AgentMode = "rule" | "deck" | "meta" | "integrated";

/** 回答に添える引用 (RAG 条文 / search_rules 結果)。UI 互換の緩い形。 */
export type Citation = Record<string, unknown>;

/**
 * エージェントのグラフ状態。`messages` は LangGraph 標準の addMessages リデューサ。
 * それ以外は上書きリデューサ (最後に返した値で置換)。citations/iterations は既定値を持つ。
 */
export const AgentState = Annotation.Root({
  ...MessagesAnnotation.spec,
  mode: Annotation<AgentMode>(),
  format: Annotation<string | undefined>(),
  // rule モードの RAG 条文。system 指示に畳み込む (2 連続 human メッセージを避けるため
  // messages には積まない。Gemini は human/ai 交互が必要)。
  ragContext: Annotation<string | undefined>(),
  /**
   * eval 専用: 事前 RAG の検索結果を差し替える (#254 の注入ケース)。api は渡さない。
   * 本番の DB は書き換えられないので、「毒入りの資料が来たとき従わないか」はここから差し込んで測る。
   */
  ragChunksOverride: Annotation<
    Array<{ text: string; score: number; meta: Record<string, unknown> }> | undefined
  >(),
  citations: Annotation<Citation[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  iterations: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),
  /**
   * 実際にデータを取れたツール呼び出しの数。
   *
   * **「ツールを呼んだ」と「根拠を得た」は別物。** ツールが落ちても AIMessage.tool_calls は
   * 残るので、呼び出し数だけを見ると全滅しても「根拠あり」に見える (#112 の失敗モード)。
   */
  toolSuccesses: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),
  /**
   * このリクエストで**実行した**ツール呼び出しの総数 (F-1)。上限超過で実行しなかった分は数えない。
   * MAX_TOOL_CALLS_PER_REQUEST に達したら finalize へ進める。
   */
  toolCallsExecuted: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),
  /** 失敗したツール名 (システム障害・引数エラー)。観測用。 */
  toolFailures: Annotation<string[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
});

export type AgentStateType = typeof AgentState.State;
