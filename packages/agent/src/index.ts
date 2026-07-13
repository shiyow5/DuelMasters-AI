import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { buildAgentGraph } from "./graph.js";
import type { AgentMode, Citation } from "./state.js";

export { configureAgent } from "./models.js";
export { runTool, type ToolResult } from "./tools.js";
export type { AgentMode, Citation } from "./state.js";
export { MAX_ITERATIONS, RAG_CONTEXT_HEADER, formatRagContext } from "./graph.js";

export interface AgentInput {
  message: string;
  mode: AgentMode;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  format?: string;
}

export interface AgentOutput {
  response: string;
  citations?: Citation[];
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  mode: AgentMode;
}

// グラフのコンパイルは一度だけ (ノード/エッジは不変、状態はリクエストごとに invoke で渡す)。
let _graph: ReturnType<typeof buildAgentGraph> | null = null;
function graph() {
  return (_graph ??= buildAgentGraph());
}

function messageText(msg: BaseMessage | undefined): string {
  if (!msg) return "";
  if (typeof msg.text === "string") return msg.text;
  return typeof msg.content === "string" ? msg.content : "";
}

/**
 * エージェントを実行し、api 互換のレスポンス形 (response / citations / toolCalls / mode) を返す。
 * 呼び出し元 (api/routes/chat.ts) はこの形をそのまま web/bot へ返す。
 */
export async function runAgent(input: AgentInput): Promise<AgentOutput> {
  const result = await graph().invoke(initialState(input));
  return toOutput(result, input.mode);
}

/** グラフの初期 state を組み立てる (runAgent / streamAgent 共通)。 */
function initialState(input: AgentInput) {
  const history: BaseMessage[] = (input.history ?? []).map((h) =>
    h.role === "assistant" ? new AIMessage(h.content) : new HumanMessage(h.content),
  );
  return {
    messages: [...history, new HumanMessage(input.message)],
    mode: input.mode,
    format: input.format,
    citations: [],
    iterations: 0,
  };
}

/** グラフの最終 state を api 互換のレスポンス形に変換する。 */
function toOutput(result: { messages: BaseMessage[]; citations: Citation[] }, mode: AgentMode) {
  // 実行されたツール呼び出しを AIMessage から収集 (UI 表示用)。
  const toolCalls = result.messages
    .filter((m): m is AIMessage => AIMessage.isInstance(m))
    .flatMap((m) => m.tool_calls ?? [])
    .map((tc) => ({ name: tc.name, args: tc.args ?? {} }));

  return {
    response: messageText(result.messages.at(-1)),
    citations: result.citations.length > 0 ? result.citations : undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    mode,
  };
}

/**
 * ストリーミング中に流すイベント。
 *
 * `token` は**進行表示のためだけ**のもの。最終的な回答は必ず `done` の `response` を使う。
 * エージェントはツールを呼ぶ前に前置きを喋ることがあり、その分もトークンとして流れてくる。
 * `tool` を受け取ったらそれまでの token を捨てる、という運用にすると表示が破綻しない。
 * ストリームが途中で壊れても `done` さえ届けば正しい回答が出せる (段階的強化)。
 */
export type AgentEvent =
  | { type: "token"; text: string }
  | { type: "tool"; name: string }
  | { type: "done"; result: AgentOutput }
  | { type: "error"; message: string };

type GraphState = { messages: BaseMessage[]; citations: Citation[] };

/**
 * メッセージチャンクから「画面に出してよいテキスト」を取り出す。
 *
 * `streamMode: "messages"` は LLM のトークンだけでなく **ToolMessage も流す**。
 * 素通しすると検索結果の生テキスト (「[112.3] 112. コスト…」) が回答として画面に出る。
 * AIMessage 系のチャンクだけを通す。
 */
export function chunkText(chunk: unknown): string {
  if (!chunk || typeof chunk !== "object") return "";

  const type = (chunk as { getType?: () => string })?.getType?.();
  if (type !== undefined && type !== "ai") return "";

  const { text, content } = chunk as { text?: unknown; content?: unknown };
  if (typeof text === "string") return text;
  if (typeof content === "string") return content;
  return "";
}

/** state の末尾 AIMessage が要求しているツール名 (無ければ空)。 */
export function pendingToolNames(state: GraphState): string[] {
  const last = state.messages.at(-1);
  if (!last || !AIMessage.isInstance(last)) return [];
  return (last.tool_calls ?? []).map((tc) => tc.name);
}

/**
 * エージェントをストリーミング実行する。
 *
 * 回答が出るまで十数秒無言になるのを避けるため、トークンとツール実行の進捗を逐次流す。
 *
 * `streamEvents` ではなく `stream(streamMode: ["values", "messages"])` を使う。
 * toolsNode は LangChain の ToolNode ではなく素の関数なので `on_tool_start` が飛ばず、
 * また `on_chain_end` はノード単位でも出るためグラフ本体の最終 state と区別しづらい。
 * `values` なら各ノード実行後の**完全な state** が来るので、最後のものが最終結果になる。
 */
export async function* streamAgent(input: AgentInput): AsyncGenerator<AgentEvent> {
  let final: GraphState | null = null;
  const announced = new Set<string>();

  const stream = await graph().stream(initialState(input), {
    streamMode: ["values", "messages"],
  });

  for await (const part of stream as AsyncIterable<[string, unknown]>) {
    const [mode, payload] = part;

    if (mode === "messages") {
      // ["messages", [chunk, metadata]]
      const text = chunkText((payload as [unknown, unknown])[0]);
      if (text !== "") yield { type: "token", text };
      continue;
    }

    if (mode === "values") {
      const state = payload as GraphState;
      final = state;
      // ツール呼び出しが決まった時点で進捗を出す (実行前に「何をしているか」を見せる)。
      for (const name of pendingToolNames(state)) {
        if (announced.has(name)) continue;
        announced.add(name);
        yield { type: "tool", name };
      }
    }
  }

  if (!final) {
    yield { type: "error", message: "エージェントの実行結果を取得できませんでした" };
    return;
  }
  yield { type: "done", result: toOutput(final, input.mode) };
}
