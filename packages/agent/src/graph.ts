import { StateGraph, START, END } from "@langchain/langgraph";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  RemoveMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { searchRules } from "@dm-ai/rag";
import { AgentState, type AgentStateType, type Citation } from "./state.js";
import { AGENT_TOOLS, runTool } from "./tools.js";
import { buildChatModel } from "./models.js";
import { SYSTEM_PROMPTS } from "./prompts.js";

/** ツール呼び出しループの上限 (暴走防止)。 */
export const MAX_ITERATIONS = 5;

/**
 * RAG context の前置き。条文が一次情報で、裁定 Q&A より優先することを明示する。
 * 公式サイトには改定前の裁定が残っており、現行の総合ルールと結論が逆のものがある。
 */
export const RAG_CONTEXT_HEADER = `以下の資料を根拠に回答してください。
【総合ルール】は現行の一次情報です。【裁定Q&A】は個別事例の公式回答ですが、改定前の古い回答が混じっていることがあります。
両者が食い違う場合は【総合ルール】を優先してください。
資料に無いことは推測で断定せず、分からないと述べてください。`;

/** メッセージからテキストを取り出す (v1 の .text getter、無ければ content)。 */
function messageText(msg: BaseMessage | undefined): string {
  if (!msg) return "";
  if (typeof msg.text === "string") return msg.text;
  return typeof msg.content === "string" ? msg.content : "";
}

/** 最新のユーザー発話を取り出す (RAG クエリ用)。 */
function latestUserQuery(messages: BaseMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (HumanMessage.isInstance(messages[i])) return messageText(messages[i]);
  }
  return messageText(messages.at(-1));
}

/**
 * RAG のヒットを context 文字列に整形する。
 *
 * 総合ルール条文と裁定 Q&A を明示的にラベル分けする。公式サイトには改定前の裁定が残っており
 * 現行の条文と食い違うことがあるため (実例: 「ターンのはじめに」の処理順)、どちらが一次情報かを
 * モデルに伝えないと古い裁定を根拠にしてしまう。
 */
export function formatRagContext(
  chunks: Array<{ text: string; meta: Record<string, unknown> }>,
): string {
  return chunks
    .map((ch, i) => {
      const label =
        ch.meta.doc_type === "comprehensive_rules"
          ? `【総合ルール${ch.meta.article ? ` ${ch.meta.article}` : ""}】`
          : "【裁定Q&A】";
      return `[${i + 1}] ${label} ${ch.text}`;
    })
    .join("\n\n");
}

/**
 * rule モードの事前 RAG。条文を context として注入し citations を state に載せる。
 * ヒットが無ければ何もしない (通常のチャットにフォールバック)。
 */
async function retrieveNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  const query = latestUserQuery(state.messages);
  if (!query) return {};
  const result = await searchRules(query);
  if (result.chunks.length === 0) return {};
  const citations: Citation[] = result.chunks.map((ch) => ({
    text: ch.text.slice(0, 100),
    ...ch.meta,
  }));
  // context は messages に human として積まず、ragContext として system へ畳み込む。
  return { ragContext: formatRagContext(result.chunks), citations };
}

/** system 指示を組み立てる (rule モードは RAG 条文を畳み込む)。 */
function buildSystemPrompt(state: AgentStateType): SystemMessage {
  const base = SYSTEM_PROMPTS[state.mode];
  const text = state.ragContext ? `${base}\n\n${RAG_CONTEXT_HEADER}\n\n${state.ragContext}` : base;
  return new SystemMessage(text);
}

/** LLM 呼び出し。ツール bind + コスト優先フォールバック。iterations を進める。 */
async function agentNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  const model = buildChatModel(AGENT_TOOLS);
  const result = await model.invoke([buildSystemPrompt(state), ...state.messages]);
  return { messages: [result], iterations: state.iterations + 1 };
}

/** 直前の AIMessage のツール呼び出しを (並列に) 実行し、ToolMessage と citations を返す。 */
async function toolsNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  const last = state.messages.at(-1);
  if (!last || !AIMessage.isInstance(last) || !last.tool_calls?.length) return {};
  const results = await Promise.all(
    last.tool_calls.map(async (call) => ({
      call,
      result: await runTool(call.name, call.args ?? {}, state.format),
    })),
  );
  const toolMessages = results.map(
    ({ call, result }) =>
      new ToolMessage({
        content: result.text,
        tool_call_id: call.id ?? call.name,
        name: call.name,
      }),
  );
  const newCitations = results.flatMap(({ result }) => result.citations ?? []);
  return {
    messages: toolMessages,
    citations: [...state.citations, ...newCitations],
  };
}

/**
 * 反復上限に達したがまだツール呼び出しが残る場合の最終回答ノード。
 * ツールを bind せずに呼び、今ある情報 (これまでの ToolMessage) で必ずテキスト回答を出させる。
 * 末尾の「未実行ツール呼び出しを含む AIMessage」は Gemini が拒否するため除去してから呼ぶ。
 */
async function finalizeNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  const messages = [...state.messages];
  const last = messages.at(-1);
  const dangling =
    last && AIMessage.isInstance(last) && (last.tool_calls?.length ?? 0) > 0 ? last : undefined;
  if (dangling) messages.pop();

  const model = buildChatModel([]);
  const system = new SystemMessage(
    `${SYSTEM_PROMPTS[state.mode]}\n\nこれ以上ツールは使用できません。現在得られている情報だけで最終回答を作成してください。`,
  );
  const result = await model.invoke([system, ...messages]);

  // 未実行のツール呼び出しを含む AIMessage を state からも除去する。
  // (messagesStateReducer は id で追記/マージするだけなので、ローカルの pop では state に残り、
  //  runAgent の toolCalls 抽出に未実行分が混入してしまう)
  const updates: BaseMessage[] = [];
  if (dangling?.id) updates.push(new RemoveMessage({ id: dangling.id }));
  updates.push(result);
  return { messages: updates };
}

/** agent の後の分岐: ツール呼び出しの有無と反復上限で tools / finalize / 終了を決める。 */
function routeAfterAgent(state: AgentStateType): "tools" | "finalize" | typeof END {
  const last = state.messages.at(-1);
  const wantsTools = last && AIMessage.isInstance(last) && (last.tool_calls?.length ?? 0) > 0;
  if (!wantsTools) return END;
  // 上限未満ならツール実行、上限到達なら finalize で強制的にテキスト回答させる。
  return state.iterations < MAX_ITERATIONS ? "tools" : "finalize";
}

/** エージェントグラフを構築する。rule モードは先に RAG、それ以外は直接 agent へ。 */
export function buildAgentGraph() {
  return new StateGraph(AgentState)
    .addNode("retrieve", retrieveNode)
    .addNode("agent", agentNode)
    .addNode("tools", toolsNode)
    .addNode("finalize", finalizeNode)
    .addConditionalEdges(START, (state) => (state.mode === "rule" ? "retrieve" : "agent"), [
      "retrieve",
      "agent",
    ])
    .addEdge("retrieve", "agent")
    .addConditionalEdges("agent", routeAfterAgent, ["tools", "finalize", END])
    .addEdge("tools", "agent")
    .addEdge("finalize", END)
    .compile();
}
