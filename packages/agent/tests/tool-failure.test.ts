import { describe, it, expect, vi, beforeEach } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import { aggregate } from "../eval/metrics.js";
import { checkThresholds } from "../eval/thresholds.js";

/**
 * ツール失敗の可視化と計測 (#109)。
 *
 * ## なぜ要るか
 *
 * ツールが失敗しても**回答は返る**。モデルは失敗を伝えるツール結果を読んで、記憶で埋めた
 * 「それらしい回答」を書く。api は 200 を返す。つまり:
 *
 * - 利用者には**普通の回答に見える** (実際にはデータで裏付けられていない)
 * - eval も judge も高いまま (回答の体裁は整っているため)
 *
 * **#112 では本番で全ツールが CONNECTION_ENDED で死んでいたのに、eval は judge 4.94 を
 * 出し続けていた。** 失敗そのものを数えないと検出できない。
 */

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

function aiToolCall(name: string, args: Record<string, unknown>) {
  return new AIMessage({
    content: "",
    tool_calls: [{ name, args, id: `call_${name}`, type: "tool_call" }],
  });
}

beforeEach(() => {
  invokeMock.mockReset();
  runToolMock.mockReset();
  searchRulesMock.mockReset();
  searchRulesMock.mockResolvedValue({ chunks: [] });
});

describe("streamAgent の toolError イベント", () => {
  it("ツールが失敗したら toolError を流す (握り潰さない)", async () => {
    const { streamAgent } = await import("../src/index.js");
    invokeMock
      .mockResolvedValueOnce(aiToolCall("search_cards", { query: "ヘブンズゲート" }))
      .mockResolvedValueOnce(new AIMessage("システム障害で確認できませんでした"));
    runToolMock.mockResolvedValueOnce({ text: "ツール実行に失敗しました", ok: false });

    const events = [];
    for await (const ev of streamAgent({ message: "ヘブンズゲートは？", mode: "deck" })) {
      events.push(ev);
    }

    const toolErrors = events.filter((e) => e.type === "toolError");
    expect(toolErrors).toEqual([{ type: "toolError", name: "search_cards" }]);

    // done にも確定リストが載る (ストリームが乱れても最終結果から分かる)
    const done = events.find((e) => e.type === "done");
    expect(done?.type === "done" && done.result.toolFailures).toEqual(["search_cards"]);
    expect(done?.type === "done" && done.result.toolSuccesses).toBe(0);
  });

  it("成功したら toolError は流れない", async () => {
    const { streamAgent } = await import("../src/index.js");
    invokeMock
      .mockResolvedValueOnce(aiToolCall("search_cards", { query: "ボルシャック" }))
      .mockResolvedValueOnce(new AIMessage("見つかりました"));
    runToolMock.mockResolvedValueOnce({ text: "ボルシャック・ドラゴン ..." });

    const events = [];
    for await (const ev of streamAgent({ message: "ボルシャックは？", mode: "deck" })) {
      events.push(ev);
    }

    expect(events.filter((e) => e.type === "toolError")).toHaveLength(0);
    const done = events.find((e) => e.type === "done");
    expect(done?.type === "done" && done.result.toolFailures).toBeUndefined();
  });
});

describe("eval のツール失敗ゲート", () => {
  it("ツールが1件でも失敗したらゲートを落とす", () => {
    // ツール失敗は回答の体裁には現れないので、judge も事実カバレッジも満点になりうる。
    // **満点でも落ちること**を確かめる — これが #112 を検出できたはずの唯一の番人。
    const agg = aggregate([
      { judgeScore: 5, factCoverage: 1, hasEvidence: true, toolFailures: ["search_cards"] },
      { judgeScore: 5, factCoverage: 1, hasEvidence: true },
    ]);
    expect(agg.toolFailureItems).toBe(1);

    const gate = checkThresholds({ ...agg, judgeFailures: 0 });
    expect(gate.passed).toBe(false);
    expect(gate.failures.join()).toContain("ツールが失敗した問 1件");
  });

  it("全て成功していれば通る", () => {
    const agg = aggregate([
      { judgeScore: 5, factCoverage: 1, hasEvidence: true, toolFailures: [] },
      { judgeScore: 5, factCoverage: 1, hasEvidence: true },
    ]);
    expect(agg.toolFailureItems).toBe(0);
    expect(checkThresholds({ ...agg, judgeFailures: 0 }).passed).toBe(true);
  });
});
