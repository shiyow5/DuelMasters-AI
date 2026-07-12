import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { buildAgentGraph } from "./graph.js";
import type { AgentMode, Citation } from "./state.js";

export { configureAgent } from "./models.js";
export { runTool, type ToolResult } from "./tools.js";
export type { AgentMode, Citation } from "./state.js";
export { MAX_ITERATIONS } from "./graph.js";

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
  const history: BaseMessage[] = (input.history ?? []).map((h) =>
    h.role === "assistant" ? new AIMessage(h.content) : new HumanMessage(h.content),
  );

  const result = await graph().invoke({
    messages: [...history, new HumanMessage(input.message)],
    mode: input.mode,
    format: input.format,
    citations: [],
    iterations: 0,
  });

  const response = messageText(result.messages.at(-1));

  // 実行されたツール呼び出しを AIMessage から収集 (UI 表示用)。
  const toolCalls = result.messages
    .filter((m): m is AIMessage => AIMessage.isInstance(m))
    .flatMap((m) => m.tool_calls ?? [])
    .map((tc) => ({ name: tc.name, args: tc.args ?? {} }));

  return {
    response,
    citations: result.citations.length > 0 ? result.citations : undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    mode: input.mode,
  };
}
