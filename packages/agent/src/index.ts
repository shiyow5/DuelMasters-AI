import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { buildAgentGraph } from "./graph.js";
import { sanitizeCitations } from "./citations.js";
import type { AgentMode, Citation } from "./state.js";

export { configureAgent } from "./models.js";
export { runTool, type ToolResult } from "./tools.js";
export { sanitizeCitations, type SanitizeResult } from "./citations.js";
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
  /**
   * 本文から**落とした**条番号 (#99)。retrieve した資料に無い = agent がでっち上げたもの。
   *
   * 空でないなら、その回で捏造が起きたということ。eval はここを見て捏造率を測る
   * (本文からは既に消えているので、本文を見ても分からない)。
   */
  ungroundedCitations?: string[];
  /**
   * 実際にデータを取れたツール呼び出しの数。
   *
   * **`toolCalls` は「モデルが呼ぼうとした」だけで、成功したかは分からない。** ツールが
   * 全滅しても tool_calls は残るので、`toolCalls.length > 0` を「根拠あり」と読むと
   * #112 の失敗モード (ツール全滅 → モデルが記憶から捏造) を素通しする。
   */
  toolSuccesses: number;
  /** 失敗したツール名 (システム障害・引数エラー)。空なら全て成功。 */
  toolFailures?: string[];
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
    toolSuccesses: 0,
    toolFailures: [],
  };
}

/** グラフの最終 state を api 互換のレスポンス形に変換する。 */
function toOutput(
  result: {
    messages: BaseMessage[];
    citations: Citation[];
    toolSuccesses?: number;
    toolFailures?: string[];
  },
  mode: AgentMode,
): AgentOutput {
  // モデルが呼ぼうとしたツール (UI 表示用)。**成功したかは含まない** — 成否は toolSuccesses。
  const toolCalls = result.messages
    .filter((m): m is AIMessage => AIMessage.isInstance(m))
    .flatMap((m) => m.tool_calls ?? [])
    .map((tc) => ({ name: tc.name, args: tc.args ?? {} }));

  // **本文の条番号を機械的に裏取りする。** プロンプトで「資料に無い条番号を書くな」と
  // 明示しても agent は捏造する (eval で【総合ルール 114.6】を確認。114章は 114.4 までしか無い)。
  // 利用者が存在しない条文を調べに行くのが最悪なので、裏取りできない番号は落とす。
  const { text: response, stripped } = sanitizeCitations(
    messageText(result.messages.at(-1)),
    result.citations,
  );

  const toolFailures = result.toolFailures ?? [];
  return {
    response,
    citations: result.citations.length > 0 ? result.citations : undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    mode,
    ungroundedCitations: stripped.length > 0 ? stripped : undefined,
    toolSuccesses: result.toolSuccesses ?? 0,
    toolFailures: toolFailures.length > 0 ? toolFailures : undefined,
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
  /** ツール実行が決まった。`args` は「何を」検索/構築しているかを画面に出すため。 */
  | { type: "tool"; name: string; args: Record<string, unknown> }
  /** グラフのノードを1つ通過した。進行表示のフェーズ切り替えに使う。 */
  | { type: "phase"; node: GraphNode }
  | { type: "done"; result: AgentOutput }
  | { type: "error"; message: string };

/**
 * 進行表示に出すグラフのノード。
 *
 * LangGraph の `updates` ストリームは `__start__` のような内部キーも流してくるので、
 * **知っているノードだけを通す**。未知のキーをそのまま画面に出すと、内部実装が
 * ユーザーに漏れるうえ、ノードを増やしたときに意味不明な文言が出る。
 */
const GRAPH_NODES = ["retrieve", "agent", "tools", "finalize"] as const;
export type GraphNode = (typeof GRAPH_NODES)[number];

/** `updates` ストリームの payload (`{ ノード名: 差分 }`) から、通過したノード名を取り出す。 */
export function phasesFromUpdate(payload: unknown): GraphNode[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  return Object.keys(payload).filter((k): k is GraphNode =>
    (GRAPH_NODES as readonly string[]).includes(k),
  );
}

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

/**
 * state の末尾 AIMessage が要求しているツール呼び出し (無ければ空)。
 *
 * **名前ではなく呼び出し ID で識別する。** グラフはツールループを回すので、同じツールを
 * クエリを変えて2回呼ぶことがある (search_rules → search_rules)。名前で重複排除すると
 * 2回目の `tool` イベントが出ず、クライアントが2回目の前置きトークンを捨てられない。
 */
export function pendingToolCalls(
  state: GraphState,
): Array<{ id: string; name: string; args: Record<string, unknown> }> {
  const last = state.messages.at(-1);
  if (!last || !AIMessage.isInstance(last)) return [];
  return (last.tool_calls ?? []).map((tc, i) => ({
    // id はモデルが付けるが、無いこともある。その場合は **メッセージ数** と位置で補う。
    // メッセージ数はループを回るたびに増えるので、同じツールを2周目に呼んでも別の鍵になる
    // (固定の接頭辞だと 2周目が 1周目と同じ鍵になり、tool イベントが抑制される)。
    id: tc.id ?? `${state.messages.length}:${i}:${tc.name}`,
    name: tc.name,
    // 引数を捨てると「ルールを検索しています」までしか出せず、**何を**検索しているかを
    // 画面に出せない。
    args: tc.args ?? {},
  }));
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
    // updates は「どのノードを通ったか」を知る唯一の手段。values は state しか来ないので、
    // retrieve が終わったのか agent が考えているのかを区別できない。
    streamMode: ["values", "messages", "updates"],
  });

  for await (const part of stream as AsyncIterable<[string, unknown]>) {
    const [mode, payload] = part;

    if (mode === "messages") {
      // ["messages", [chunk, metadata]]
      const text = chunkText((payload as [unknown, unknown])[0]);
      if (text !== "") yield { type: "token", text };
      continue;
    }

    if (mode === "updates") {
      for (const node of phasesFromUpdate(payload)) yield { type: "phase", node };
      continue;
    }

    if (mode === "values") {
      const state = payload as GraphState;
      final = state;
      // ツール呼び出しが決まった時点で進捗を出す (実行前に「何をしているか」を見せる)。
      // 同じ state が複数回流れてくるので呼び出し ID で重複を除く。
      for (const call of pendingToolCalls(state)) {
        if (announced.has(call.id)) continue;
        announced.add(call.id);
        yield { type: "tool", name: call.name, args: call.args };
      }
    }
  }

  if (!final) {
    yield { type: "error", message: "エージェントの実行結果を取得できませんでした" };
    return;
  }
  yield { type: "done", result: toOutput(final, input.mode) };
}
