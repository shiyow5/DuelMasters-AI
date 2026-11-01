import { describe, it, expect, vi, beforeEach } from "vitest";
import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";

/**
 * ツール呼び出し本数の上限 (F-1)。
 *
 * MAX_ITERATIONS だけでは 1ターンに何十本も tool_calls を並べられ、DB と Gemini が膨らむ。
 * 1ターン 3本 / 1リクエスト 8本までに絞る。**超過分にも ToolMessage を返す** —
 * tool_call と ToolMessage の対応が欠けると Gemini がエラーにする。
 */

const invokeMock = vi.fn();
const runToolMock = vi.fn();

vi.mock("../src/models.js", () => ({
  buildChatModel: () => ({ invoke: invokeMock }),
  configureAgent: () => {},
}));
vi.mock("../src/tools.js", () => ({
  AGENT_TOOLS: [],
  runTool: (...args: unknown[]) => runToolMock(...args),
}));
vi.mock("@dm-ai/rag", () => ({
  searchRules: async () => ({ chunks: [] }),
}));

const { runAgent, MAX_TOOL_CALLS_PER_TURN, MAX_TOOL_CALLS_PER_REQUEST, TOOL_CALL_LIMIT_MESSAGE } =
  await import("../src/index.js");

let seq = 0;
function aiWithToolCalls(n: number) {
  return new AIMessage({
    content: "",
    tool_calls: Array.from({ length: n }, () => {
      seq += 1;
      return {
        name: "search_cards",
        args: { query: `q${seq}` },
        id: `call_${seq}`,
        type: "tool_call" as const,
      };
    }),
  });
}

/** モデルに渡った messages のうち ToolMessage だけを取り出す (最後の invoke 時点)。 */
function toolMessagesSeenByModel(): ToolMessage[] {
  const lastCall = invokeMock.mock.calls.at(-1)?.[0] as BaseMessage[];
  return lastCall.filter((m): m is ToolMessage => ToolMessage.isInstance(m));
}

beforeEach(() => {
  seq = 0;
  invokeMock.mockReset();
  runToolMock.mockReset();
  runToolMock.mockResolvedValue({ text: "結果", ok: true });
});

describe("toolsNode のツール本数上限", () => {
  it("上限値は 1ターン3本 / 1リクエスト8本", () => {
    expect(MAX_TOOL_CALLS_PER_TURN).toBe(3);
    expect(MAX_TOOL_CALLS_PER_REQUEST).toBe(8);
  });

  it("tool_calls 5本 → runTool は3回、ToolMessage は5件 (2件は上限超過の文言)", async () => {
    invokeMock
      .mockResolvedValueOnce(aiWithToolCalls(5))
      .mockResolvedValueOnce(new AIMessage("回答"));

    const out = await runAgent({ message: "質問", mode: "deck" });

    expect(runToolMock).toHaveBeenCalledTimes(3);
    const tms = toolMessagesSeenByModel();
    expect(tms).toHaveLength(5);
    // 全ての tool_call に対応する ToolMessage がある (Gemini の対応チェック)
    expect(tms.map((m) => m.tool_call_id).sort()).toEqual(
      ["call_1", "call_2", "call_3", "call_4", "call_5"].sort(),
    );
    const skipped = tms.filter((m) => m.content === TOOL_CALL_LIMIT_MESSAGE);
    expect(skipped.map((m) => m.tool_call_id).sort()).toEqual(["call_4", "call_5"]);
    expect(out.response).toBe("回答");
    expect(out.toolSuccesses).toBe(3);
  });

  it("1リクエスト総数8本に達したら、それ以上実行せず finalize で回答する", async () => {
    // 3 + 3 + 2(残り枠) = 8 本実行。3ターン目の超過1本は上限超過の ToolMessage。
    // 4ターン目の要求は実行されず finalize (ツールなしで回答) に回る。
    invokeMock
      .mockResolvedValueOnce(aiWithToolCalls(3))
      .mockResolvedValueOnce(aiWithToolCalls(3))
      .mockResolvedValueOnce(aiWithToolCalls(3))
      .mockResolvedValueOnce(aiWithToolCalls(2))
      .mockResolvedValueOnce(new AIMessage("最終回答"));

    const out = await runAgent({ message: "質問", mode: "deck" });

    expect(runToolMock).toHaveBeenCalledTimes(MAX_TOOL_CALLS_PER_REQUEST);
    expect(invokeMock).toHaveBeenCalledTimes(5);
    const tms = toolMessagesSeenByModel();
    expect(tms).toHaveLength(9);
    expect(tms.filter((m) => m.content === TOOL_CALL_LIMIT_MESSAGE)).toHaveLength(1);
    // finalize に渡す messages には未実行の tool_calls を含む AIMessage を残さない
    const finalInput = invokeMock.mock.calls.at(-1)?.[0] as BaseMessage[];
    const lastAi = finalInput.filter((m) => AIMessage.isInstance(m)).at(-1) as AIMessage;
    expect(lastAi.tool_calls?.map((c) => c.id)).toEqual(["call_7", "call_8", "call_9"]);
    expect(out.response).toBe("最終回答");
  });

  it("上限内 (2本) なら全部実行し、上限超過の文言は出ない", async () => {
    invokeMock
      .mockResolvedValueOnce(aiWithToolCalls(2))
      .mockResolvedValueOnce(new AIMessage("回答"));

    await runAgent({ message: "質問", mode: "deck" });

    expect(runToolMock).toHaveBeenCalledTimes(2);
    expect(toolMessagesSeenByModel().some((m) => m.content === TOOL_CALL_LIMIT_MESSAGE)).toBe(
      false,
    );
  });
});
