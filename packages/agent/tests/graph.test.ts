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
    // 既定はヒット0件。#108 で integrated も retrieve を通るようになったため、
    // 明示的にヒットを積まない問でも searchRules が呼ばれる。
    searchRulesMock.mockResolvedValue({ chunks: [] });
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

  /**
   * **「ツールを呼んだ」と「根拠を得た」は別物。**
   *
   * ツールが落ちても AIMessage.tool_calls は残るので、呼び出し数だけを見ると
   * 全滅しても「根拠あり」に見える。#112 (ストリーミング中に DB 接続が切れて全ツールが
   * CONNECTION_ENDED で死んだ) では、まさにその状態でモデルが記憶から捏造した。
   * eval の evidenceRate がこれを素通しすると、番人として無意味になる。
   */
  it("ツールが失敗したら toolSuccesses は増えない (呼び出し数では根拠を測れない)", async () => {
    const { runAgent } = await import("../src/index.js");
    invokeMock
      .mockResolvedValueOnce(aiToolCall("search_cards", { query: "ヘブンズゲート" }))
      .mockResolvedValueOnce(aiText("システム障害で確認できませんでした"));
    runToolMock.mockResolvedValueOnce({
      text: "ツール実行に失敗しました",
      ok: false,
      systemFailure: true,
    });

    const out = await runAgent({ message: "ヘブンズゲートは？", mode: "deck" });

    // モデルは呼ぼうとしたので toolCalls には残る
    expect(out.toolCalls).toHaveLength(1);
    // しかし**データは取れていない**
    expect(out.toolSuccesses).toBe(0);
    expect(out.toolFailures).toEqual(["search_cards"]);
  });

  it("引数エラーは「失敗」に数えない (システムは壊れていない)", async () => {
    // モデルが存在しない文明を指定した等。呼び直せば回復するので、利用者への警告も
    // eval のゲート落としも筋違い。ただし**データは取れていない**ので根拠にはならない。
    const { runAgent } = await import("../src/index.js");
    invokeMock
      .mockResolvedValueOnce(aiToolCall("search_cards", { civilization: "虹" }))
      .mockResolvedValueOnce(aiText("虹文明は存在しません"));
    runToolMock.mockResolvedValueOnce({ text: "文明「虹」は存在しません", ok: false });

    const out = await runAgent({ message: "虹文明は？", mode: "deck" });

    expect(out.toolFailures).toBeUndefined();
    expect(out.toolSuccesses).toBe(0);
  });

  it("ツールが成功したら toolSuccesses が増える (0件でも成功)", async () => {
    const { runAgent } = await import("../src/index.js");
    invokeMock
      .mockResolvedValueOnce(aiToolCall("search_cards", { query: "存在しないカード" }))
      .mockResolvedValueOnce(aiText("該当するカードはありませんでした"));
    // 0件は**成功**。検索は動いており「該当なし」という事実が得られている (#111)。
    runToolMock.mockResolvedValueOnce({ text: "条件に一致するカードは0件でした" });

    const out = await runAgent({ message: "存在しないカードは？", mode: "deck" });

    expect(out.toolSuccesses).toBe(1);
    expect(out.toolFailures).toBeUndefined();
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

  /**
   * #108: web の既定モードは integrated。ここが retrieve を通らないと、ルールを聞かれても
   * ツールを呼ぶかは LLM 任せになり、呼ばなければ**記憶だけで答える** (本番実測 8問中1問)。
   */
  it("integrated モードも事前 RAG を通り、関連が強ければ citations を付ける", async () => {
    const { runAgent } = await import("../src/index.js");
    // 実測したルール質問の top スコア帯 (0.764〜0.897)。
    searchRulesMock.mockResolvedValueOnce({
      chunks: [{ text: "マナゾーンには1ターンに1枚", meta: { article: "501.2" }, score: 0.85 }],
    });
    invokeMock.mockResolvedValueOnce(aiText("1ターンに1枚です"));

    const out = await runAgent({ message: "マナゾーンに置ける枚数は？", mode: "integrated" });

    expect(searchRulesMock).toHaveBeenCalled();
    expect(out.citations).toHaveLength(1);
  });

  it("integrated でルールと無関係な質問なら条文を積まない", async () => {
    const { runAgent } = await import("../src/index.js");
    // 実測した非ルール質問の top スコア帯 (0.576〜0.674)。デッキ構築の質問に
    // 無関係な条文と出典が付くのを防ぐ。
    searchRulesMock.mockResolvedValueOnce({
      chunks: [{ text: "無関係な条文", meta: { article: "101.1" }, score: 0.62 }],
    });
    invokeMock.mockResolvedValueOnce(aiText("デッキを組みます"));

    const out = await runAgent({ message: "赤単速攻を組んで", mode: "integrated" });

    expect(searchRulesMock).toHaveBeenCalled();
    expect(out.citations).toBeUndefined();
  });

  it("deck / meta モードは事前 RAG を通らない", async () => {
    const { runAgent } = await import("../src/index.js");
    invokeMock.mockResolvedValueOnce(aiText("ティア表です"));

    await runAgent({ message: "ティアは？", mode: "meta" });

    expect(searchRulesMock).not.toHaveBeenCalled();
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
    // 実行されたツールは MAX-1 回 (最後の反復のツール呼び出しは finalize 送りで未実行)
    expect(runToolMock).toHaveBeenCalledTimes(MAX_ITERATIONS - 1);
    // 未実行の dangling tool-call は RemoveMessage で除去され toolCalls に混入しない
    expect(out.toolCalls).toHaveLength(MAX_ITERATIONS - 1);
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

const { formatRagContext, RAG_CONTEXT_HEADER } = await import("../src/index.js");

describe("formatRagContext", () => {
  // 公式サイトには改定前の裁定が残り、現行の条文と結論が逆のものがある。
  // どちらが一次情報かをラベルで示さないと、モデルが古い裁定を根拠にしてしまう。
  it("総合ルール条文と裁定Q&Aをラベルで区別する", () => {
    const ctx = formatRagContext([
      {
        text: "113.6. 使用宣言を行えます。",
        meta: { doc_type: "comprehensive_rules", article: "113.6" },
      },
      { text: "Q: 使えますか？\nA: はい。", meta: { doc_type: "ruling", qa_id: 123 } },
    ]);
    expect(ctx).toContain("[1] 【総合ルール 113.6】");
    expect(ctx).toContain("[2] 【裁定Q&A】");
  });

  it("faq を裁定と偽らない (公式裁定ではないため)", () => {
    const ctx = formatRagContext([
      { text: "よくある質問の本文", meta: { doc_type: "faq" } },
      { text: "由来不明の本文", meta: {} },
    ]);
    expect(ctx).toContain("[1] 【FAQ】");
    expect(ctx).not.toContain("【裁定Q&A】");
    expect(ctx).toContain("[2] 【参考】");
  });

  it("条番号が無い条文でもラベルは付く", () => {
    const ctx = formatRagContext([
      { text: "512. 次のターンに移行する時", meta: { doc_type: "comprehensive_rules" } },
    ]);
    expect(ctx).toContain("[1] 【総合ルール】");
  });
});

describe("RAG_CONTEXT_HEADER", () => {
  it("条文が裁定より優先することを明示する", () => {
    expect(RAG_CONTEXT_HEADER).toContain("【総合ルール】を優先");
    expect(RAG_CONTEXT_HEADER).toContain("改定前の古い回答");
  });
});
