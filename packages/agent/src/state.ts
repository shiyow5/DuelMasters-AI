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
  citations: Annotation<Citation[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  iterations: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),
});

export type AgentStateType = typeof AgentState.State;
