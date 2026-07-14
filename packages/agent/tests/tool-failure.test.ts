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
    runToolMock.mockResolvedValueOnce({
      text: "ツール実行に失敗しました",
      ok: false,
      systemFailure: true,
    });

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

  /**
   * **この PR が依存している不変条件。**
   *
   * `toolFailures` は上書きリデューサだが、toolsNode 側が `[...state.toolFailures, ...failed]`
   * と積み上げて返すので、実行を通して単調増加する。streamAgent はその**差分**だけを流す
   * (`announcedFailures`)。values ストリームは同じ state を何度も流すので、差分を取らないと
   * 同じ失敗を何度も流してしまう。
   *
   * ここが壊れると「2周目の失敗が流れない」「同じ失敗が二重に出る」といった形で、
   * **失敗の可視化そのものが信用できなくなる**。
   */
  it("ツールループを2周して両方失敗しても、取りこぼしも重複もしない", async () => {
    const { streamAgent } = await import("../src/index.js");
    invokeMock
      .mockResolvedValueOnce(aiToolCall("search_cards", { query: "1回目" }))
      .mockResolvedValueOnce(aiToolCall("search_rules", { query: "2回目" }))
      .mockResolvedValueOnce(new AIMessage("確認できませんでした"));
    runToolMock
      .mockResolvedValueOnce({ text: "失敗1", ok: false, systemFailure: true })
      .mockResolvedValueOnce({ text: "失敗2", ok: false, systemFailure: true });

    const events = [];
    for await (const ev of streamAgent({ message: "質問", mode: "deck" })) events.push(ev);

    expect(events.filter((e) => e.type === "toolError")).toEqual([
      { type: "toolError", name: "search_cards" },
      { type: "toolError", name: "search_rules" },
    ]);
    const done = events.find((e) => e.type === "done");
    expect(done?.type === "done" && done.result.toolFailures).toEqual([
      "search_cards",
      "search_rules",
    ]);
  });

  /**
   * finalizeNode は反復上限に達したとき、**未実行のツール呼び出しを含む AIMessage を
   * RemoveMessage で state から消す**。この巻き戻しが toolFailures を壊さないことを固定する。
   * (壊れると、上限に達した回だけ失敗が消えて「静かに間違った回答」に戻る。)
   */
  it("MAX_ITERATIONS で finalize に落ちても、それまでの失敗は消えない", async () => {
    const { streamAgent, MAX_ITERATIONS } = await import("../src/index.js");
    // 毎回ツールを呼び続けるモデル。上限到達後、finalize ではテキストを返す。
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      invokeMock.mockResolvedValueOnce(aiToolCall("search_cards", { query: `${i}` }));
    }
    invokeMock.mockResolvedValueOnce(new AIMessage("確認できませんでした"));
    runToolMock.mockResolvedValue({ text: "失敗", ok: false, systemFailure: true });

    const events = [];
    for await (const ev of streamAgent({ message: "質問", mode: "deck" })) events.push(ev);

    // 上限に達した回のツール呼び出しは**実行されない** (finalize が捨てる) ので、
    // 失敗は MAX_ITERATIONS - 1 回。
    const errors = events.filter((e) => e.type === "toolError");
    expect(errors).toHaveLength(MAX_ITERATIONS - 1);

    const done = events.find((e) => e.type === "done");
    expect(done?.type === "done" && done.result.toolFailures).toHaveLength(MAX_ITERATIONS - 1);
    expect(done?.type === "done" && done.result.toolSuccesses).toBe(0);
  });

  /**
   * **引数エラーはシステム障害ではない。**
   *
   * 本番で実測した誤報: モデルが `civilization=虹` (存在しない文明) で検索し、ツールは
   * 引数エラーを返した。モデルはそれを受けて「虹文明は存在しません」と**総合ルール
   * 106.1/106.2 を引用して正しく答えた** (引用9件)。にもかかわらず web には
   * 「この回答はデータで裏付けられていません」と警告が出た。
   *
   * 引数エラーはモデルの推測ミスであって、システムは壊れていない。モデルは呼び直して
   * 回復できる。警告もゲート落としも筋違い。根拠の有無は toolSuccesses で測る。
   */
  it("引数エラーでは toolError を流さない (システムは壊れていない)", async () => {
    const { streamAgent } = await import("../src/index.js");
    invokeMock
      .mockResolvedValueOnce(aiToolCall("search_cards", { civilization: "虹" }))
      .mockResolvedValueOnce(new AIMessage("虹文明は存在しません"));
    // 引数エラー: データは取れていない (ok:false) が、システムは壊れていない
    runToolMock.mockResolvedValueOnce({ text: "文明「虹」は存在しません", ok: false });

    const events = [];
    for await (const ev of streamAgent({ message: "虹文明は？", mode: "deck" })) events.push(ev);

    expect(events.filter((e) => e.type === "toolError")).toHaveLength(0);
    const done = events.find((e) => e.type === "done");
    expect(done?.type === "done" && done.result.toolFailures).toBeUndefined();
    // ただし**データは取れていない**ので、根拠としては数えない
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
