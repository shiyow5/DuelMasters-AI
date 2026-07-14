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
【総合ルール】は現行の一次情報です。【裁定Q&A】は個別事例の公式回答ですが、改定前の古い回答が混じっていることがあります。【FAQ】【参考】はそれより弱い資料です。
食い違う場合は【総合ルール】を優先してください。
資料に無いことは推測で断定せず、分からないと述べてください。`;

/**
 * integrated モードでの RAG context の前置き (#108)。
 *
 * rule モードと同じ強い前置き (「資料に無いことは分からないと述べてください」) は使えない。
 * integrated はデッキ構築や環境の質問も受けるため、その前置きを付けると
 * **「デッキの組み方は資料に無いので分かりません」と拒否しかねない**。
 * 「ルールの話なら必ずこれを根拠に、そうでなければ無視してよい」と伝える。
 */
export const INTEGRATED_RAG_CONTEXT_HEADER = `以下はルール検索の結果です。
**ルールや裁定に関わる質問なら、必ずこの資料を根拠にして答えてください** (記憶で答えないこと)。
【総合ルール】が現行の一次情報です。【裁定Q&A】には改定前の古い回答が混じることがあるので、食い違う場合は【総合ルール】を優先してください。
デッキ構築・カード検索・環境分析など、ルールと関係ない質問であればこの資料は無視して構いません。`;

/**
 * integrated で RAG 結果を採用する最小スコア (#108)。
 *
 * integrated では「ルールの質問かどうか」が事前に分からない。常に条文を積むと、デッキ構築の
 * 質問にも無関係な条文と出典が付いてしまう。かといって LLM の判断に任せると**呼ばない**
 * (本番実測 8問中1問がツール未使用・引用ゼロ)。そこで検索スコアで機械的に足切りする。
 *
 * 実測 (本番相当データ / rule_chunks 3594件、hybridSearch の top スコア):
 *   ルール質問        0.764 〜 0.897  (S・トリガー / マナゾーン / ブロッカー / 召喚酔い /
 *                                     山札切れ / 進化クリーチャーの召喚酔い)
 *   非ルール質問      0.576 〜 0.674  (赤単速攻を組んで / ボルシャックを検索 /
 *                                     ティア1は / 遊戯王のルール / デッキ改善案)
 * 0.674 と 0.764 の間に谷があるので、その下側に寄せて 0.70 を採る。
 *
 * 割った場合は「条文を積まない」= 現状の挙動 (モデルが必要と思えば search_rules を呼ぶ) に
 * 戻るだけで、悪化はしない。取りこぼしより誤爆を嫌って高くしすぎない方が良い。
 */
export const INTEGRATED_RAG_MIN_SCORE = 0.7;

/** 事前 RAG を通すモード。integrated は web の既定なので、ここを外すと根拠ゼロ回答が出る。 */
function usesRetrieval(mode: string): boolean {
  return mode === "rule" || mode === "integrated";
}

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
  return chunks.map((ch, i) => `[${i + 1}] ${sourceLabel(ch.meta)} ${ch.text}`).join("\n\n");
}

/**
 * 出典ラベル。doc_type ごとに分ける。
 * faq (公式サイトの一般的な Q&A) を「裁定」と呼ぶと、個別事例の公式回答と誤認させてしまう。
 */
function sourceLabel(meta: Record<string, unknown>): string {
  switch (meta.doc_type) {
    case "comprehensive_rules":
      return `【総合ルール${meta.article ? ` ${meta.article}` : ""}】`;
    case "ruling":
      return "【裁定Q&A】";
    case "faq":
      return "【FAQ】";
    default:
      return "【参考】";
  }
}

/**
 * RAG 結果を採用するか。rule モードは常に採用する (利用者が明示的にルールを聞いている)。
 * integrated は「ルールの質問かどうか」が分からないので、検索スコアで足切りする。
 */
export function acceptsRagResult(mode: string, chunks: Array<{ score: number }>): boolean {
  if (chunks.length === 0) return false;
  if (mode !== "integrated") return true;
  const top = Math.max(...chunks.map((c) => c.score));
  return top >= INTEGRATED_RAG_MIN_SCORE;
}

/**
 * 事前 RAG (rule / integrated)。条文を context として注入し citations を state に載せる。
 * ヒットが無い、または integrated で関連が薄ければ何もしない (通常のチャットにフォールバック)。
 */
async function retrieveNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  const query = latestUserQuery(state.messages);
  if (!query) return {};
  const result = await searchRules(query);
  if (!acceptsRagResult(state.mode, result.chunks)) return {};
  const citations: Citation[] = result.chunks.map((ch) => ({
    text: ch.text.slice(0, 100),
    ...ch.meta,
  }));
  // context は messages に human として積まず、ragContext として system へ畳み込む。
  return { ragContext: formatRagContext(result.chunks), citations };
}

/**
 * system 指示を組み立てる (事前 RAG の条文を畳み込む)。
 * 前置きはモードで変える — integrated に rule 用の強い前置きを付けるとデッキ構築を拒否しかねない。
 */
export function buildSystemPrompt(state: AgentStateType): SystemMessage {
  const base = SYSTEM_PROMPTS[state.mode];
  if (!state.ragContext) return new SystemMessage(base);
  const header = state.mode === "integrated" ? INTEGRATED_RAG_CONTEXT_HEADER : RAG_CONTEXT_HEADER;
  return new SystemMessage(`${base}\n\n${header}\n\n${state.ragContext}`);
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

/**
 * エージェントグラフを構築する。rule / integrated は先に RAG、deck / meta は直接 agent へ。
 *
 * integrated を retrieve に通すのが #108 の修正。**web の既定モードは integrated** なので、
 * ここを外すと「ルールを聞いたのにツールを1つも呼ばず、記憶だけで答える」が起きる
 * (本番実測 8問中1問)。プロンプトで「search_rules を呼べ」と書いても守られないことは実証済み。
 */
export function buildAgentGraph() {
  return new StateGraph(AgentState)
    .addNode("retrieve", retrieveNode)
    .addNode("agent", agentNode)
    .addNode("tools", toolsNode)
    .addNode("finalize", finalizeNode)
    .addConditionalEdges(START, (state) => (usesRetrieval(state.mode) ? "retrieve" : "agent"), [
      "retrieve",
      "agent",
    ])
    .addEdge("retrieve", "agent")
    .addConditionalEdges("agent", routeAfterAgent, ["tools", "finalize", END])
    .addEdge("tools", "agent")
    .addEdge("finalize", END)
    .compile();
}
