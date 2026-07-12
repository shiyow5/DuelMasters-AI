import { describe, it, expect, vi, beforeEach } from "vitest";
import { AIMessage } from "@langchain/core/messages";

// モデル呼び出し・ツール実行・RAG をモックし、グラフの制御フローのみを検証する。
const invokeMock = vi.fn();
const runToolMock = vi.fn();
const searchRulesMock = vi.fn();

vi.mock("../src/models.js", () => ({
  buildChatModel: () => ({ invoke: invokeMock }),
  configureAgent: () => {},
}));

vi.mock("../src/tools.js", () => ({
  AGENT_TOOLS: [],
  runTool: (...args: unknown[]) => runToolMock(...args),
}));

vi.mock("@dm-ai/rag", () => ({
  searchRules: (...args: unknown[]) => searchRulesMock(...args),
}));

function aiText(text: string) {
  return new AIMessage(text);
}

function aiToolCall(name: string, args: Record<string, unknown>) {
  return new AIMessage({
    content: "",
    tool_calls: [{ name, args, id: `call_${name}`, type: "tool_call" }],
  });
}

describe("runAgent グラフ制御フロー", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    runToolMock.mockReset();
    searchRulesMock.mockReset();
  });

  it("ツール無しの応答をそのまま返す (deck モード)", async () => {
    const { runAgent } = await import("../src/index.js");
    invokeMock.mockResolvedValueOnce(aiText("デッキ評価の結果です"));

    const out = await runAgent({ message: "評価して", mode: "deck" });

    expect(out.response).toBe("デッキ評価の結果です");
    expect(out.toolCalls).toBeUndefined();
    expect(out.citations).toBeUndefined();
    expect(out.mode).toBe("deck");
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(runToolMock).not.toHaveBeenCalled();
  });

  it("ツール呼び出し→結果を踏まえた最終応答 (integrated モード)", async () => {
    const { runAgent } = await import("../src/index.js");
    invokeMock
      .mockResolvedValueOnce(aiToolCall("search_cards", { query: "ボルシャック" }))
      .mockResolvedValueOnce(aiText("該当カードはこちらです"));
    runToolMock.mockResolvedValueOnce({ text: "ボルシャック・ドラゴン ..." });

    const out = await runAgent({ message: "ボルシャックを探して", mode: "integrated" });

    expect(out.response).toBe("該当カードはこちらです");
    expect(out.toolCalls).toEqual([{ name: "search_cards", args: { query: "ボルシャック" } }]);
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(runToolMock).toHaveBeenCalledTimes(1);
    expect(runToolMock).toHaveBeenCalledWith("search_cards", { query: "ボルシャック" }, undefined);
  });

  it("rule モードは事前 RAG で citations を付与する", async () => {
    const { runAgent } = await import("../src/index.js");
    searchRulesMock.mockResolvedValueOnce({
      chunks: [
        { text: "Sトリガーはブロックされない", meta: { article: "1234.5" } },
        { text: "別の条文", meta: { article: "1234.6" } },
      ],
    });
    invokeMock.mockResolvedValueOnce(aiText("結論: ブロックされません"));

    const out = await runAgent({ message: "Sトリガーはブロックされる?", mode: "rule" });

    expect(out.response).toBe("結論: ブロックされません");
    expect(searchRulesMock).toHaveBeenCalledTimes(1);
    expect(out.citations).toHaveLength(2);
    expect(out.citations?.[0]).toMatchObject({ article: "1234.5" });
  });

  it("rule モードで RAG ヒット無しなら citations 無しで通常応答", async () => {
    const { runAgent } = await import("../src/index.js");
    searchRulesMock.mockResolvedValueOnce({ chunks: [] });
    invokeMock.mockResolvedValueOnce(aiText("一般的な回答"));

    const out = await runAgent({ message: "曖昧な質問", mode: "rule" });

    expect(out.response).toBe("一般的な回答");
    expect(out.citations).toBeUndefined();
  });

  it("ツールを呼び続けても MAX_ITERATIONS で打ち切り finalize で最終回答する", async () => {
    const { runAgent, MAX_ITERATIONS } = await import("../src/index.js");
    // 上限まではツール呼び出し、finalize (上限+1回目) ではテキスト回答を返すモデル
    let n = 0;
    invokeMock.mockImplementation(async () => {
      n += 1;
      return n > MAX_ITERATIONS
        ? aiText("これ以上は現状の情報で回答します")
        : aiToolCall("search_rules", { query: "x" });
    });
    runToolMock.mockResolvedValue({ text: "result" });

    const out = await runAgent({ message: "無限", mode: "integrated" });

    // agent を MAX 回 + finalize 1 回 = MAX+1 回モデルを呼ぶ
    expect(invokeMock).toHaveBeenCalledTimes(MAX_ITERATIONS + 1);
    expect(out.response).toBe("これ以上は現状の情報で回答します");
  });

  it("history を messages に引き継ぐ", async () => {
    const { runAgent } = await import("../src/index.js");
    invokeMock.mockResolvedValueOnce(aiText("ok"));

    await runAgent({
      message: "続き",
      mode: "integrated",
      history: [
        { role: "user", content: "前の質問" },
        { role: "assistant", content: "前の回答" },
      ],
    });

    const passedMessages = invokeMock.mock.calls[0][0];
    // system + history(2) + 最新 user = 4
    expect(passedMessages.length).toBe(4);
  });
});
