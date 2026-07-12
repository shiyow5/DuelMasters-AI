import { StateGraph, START, END } from "@langchain/langgraph";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { searchRules } from "@dm-ai/rag";
import { AgentState, type AgentStateType, type Citation } from "./state.js";
import { AGENT_TOOLS, runTool } from "./tools.js";
import { buildChatModel } from "./models.js";
import { SYSTEM_PROMPTS } from "./prompts.js";

/** ツール呼び出しループの上限 (暴走防止)。 */
export const MAX_ITERATIONS = 5;

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
 * rule モードの事前 RAG。条文を context として注入し citations を state に載せる。
 * ヒットが無ければ何もしない (通常のチャットにフォールバック)。
 */
async function retrieveNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  const query = latestUserQuery(state.messages);
  if (!query) return {};
  const result = await searchRules(query);
  if (result.chunks.length === 0) return {};
  const context = result.chunks
    .map((ch, i) => `[${i + 1}] ${ch.meta.article ? `条${ch.meta.article}: ` : ""}${ch.text}`)
    .join("\n\n");
  const citations: Citation[] = result.chunks.map((ch) => ({
    text: ch.text.slice(0, 100),
    ...ch.meta,
  }));
  return {
    messages: [new HumanMessage(`以下のルール条文を参考に回答してください:\n\n${context}`)],
    citations,
  };
}

/** LLM 呼び出し。ツール bind + コスト優先フォールバック。iterations を進める。 */
async function agentNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  const model = buildChatModel(AGENT_TOOLS);
  const system = new SystemMessage(SYSTEM_PROMPTS[state.mode]);
  const result = await model.invoke([system, ...state.messages]);
  return { messages: [result], iterations: state.iterations + 1 };
}

/** 直前の AIMessage のツール呼び出しを実行し、ToolMessage と citations を返す。 */
async function toolsNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  const last = state.messages.at(-1);
  if (!last || !AIMessage.isInstance(last) || !last.tool_calls?.length) return {};
  const toolMessages: ToolMessage[] = [];
  const newCitations: Citation[] = [];
  for (const call of last.tool_calls) {
    const { text, citations } = await runTool(call.name, call.args ?? {}, state.format);
    if (citations?.length) newCitations.push(...citations);
    toolMessages.push(
      new ToolMessage({
        content: text,
        tool_call_id: call.id ?? call.name,
        name: call.name,
      }),
    );
  }
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
  if (last && AIMessage.isInstance(last) && (last.tool_calls?.length ?? 0) > 0) {
    messages.pop();
  }
  const model = buildChatModel([]);
  const system = new SystemMessage(
    `${SYSTEM_PROMPTS[state.mode]}\n\nこれ以上ツールは使用できません。現在得られている情報だけで最終回答を作成してください。`,
  );
  const result = await model.invoke([system, ...messages]);
  return { messages: [result] };
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
