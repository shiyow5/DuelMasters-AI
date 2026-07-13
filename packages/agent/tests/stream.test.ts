import { describe, it, expect } from "vitest";
import { AIMessageChunk, ToolMessage, HumanMessage } from "@langchain/core/messages";
import { chunkText, pendingToolCalls, phasesFromUpdate } from "../src/index.js";

describe("phasesFromUpdate", () => {
  // LangGraph の streamMode: "updates" は `{ ノード名: 状態の差分 }` を流す。
  // これが唯一「グラフのどこを通ったか」を知る手段 (values は state しか来ない)。
  it("更新のあったノード名を返す", () => {
    expect(phasesFromUpdate({ retrieve: { citations: [] } })).toEqual(["retrieve"]);
    expect(phasesFromUpdate({ tools: { messages: [] } })).toEqual(["tools"]);
  });

  it("複数ノードが同時に更新されても全部返す", () => {
    expect(phasesFromUpdate({ agent: {}, tools: {} })).toEqual(["agent", "tools"]);
  });

  it("グラフのノードでないキーは無視する (LangGraph の内部キーを進捗として出さない)", () => {
    expect(phasesFromUpdate({ __start__: {}, retrieve: {} })).toEqual(["retrieve"]);
    expect(phasesFromUpdate({ unknown_node: {} })).toEqual([]);
  });

  it("null や配列は空", () => {
    expect(phasesFromUpdate(null)).toEqual([]);
    expect(phasesFromUpdate([1, 2])).toEqual([]);
    expect(phasesFromUpdate("retrieve")).toEqual([]);
  });
});

describe("chunkText", () => {
  it("AI のチャンクからテキストを取り出す", () => {
    expect(chunkText(new AIMessageChunk({ content: "こんにちは" }))).toBe("こんにちは");
  });

  it("ToolMessage は流さない", () => {
    // streamMode: "messages" は ToolMessage も流す。素通しすると検索結果の生テキストが
    // 回答として画面に出てしまう (実際に出た)。
    const tool = new ToolMessage({
      content: "[112.3] 112. コスト\n112.3. マナコストを...",
      tool_call_id: "1",
      name: "search_rules",
    });
    expect(chunkText(tool)).toBe("");
  });

  it("ユーザー発話も流さない", () => {
    expect(chunkText(new HumanMessage("質問です"))).toBe("");
  });

  it("null / 未知の形は空文字", () => {
    expect(chunkText(null)).toBe("");
    expect(chunkText(undefined)).toBe("");
    expect(chunkText(42)).toBe("");
    expect(chunkText({})).toBe("");
  });
});

describe("pendingToolCalls", () => {
  it("末尾 AIMessage のツール呼び出しを ID・引数つきで返す", () => {
    // 引数を捨てると「ルールを検索しています」までしか出せず、**何を**検索しているかを
    // 画面に出せない (#98 の主眼)。
    const state = {
      messages: [
        new HumanMessage("質問"),
        new AIMessageChunk({
          content: "",
          tool_calls: [
            { name: "search_rules", args: { query: "S・トリガー 任意" }, id: "1" },
            { name: "search_cards", args: { query: "ボルシャック" }, id: "2" },
          ],
        }),
      ],
      citations: [],
    };
    expect(pendingToolCalls(state)).toEqual([
      { id: "1", name: "search_rules", args: { query: "S・トリガー 任意" } },
      { id: "2", name: "search_cards", args: { query: "ボルシャック" } },
    ]);
  });

  it("引数が無ければ空オブジェクトにする", () => {
    const state = {
      messages: [
        new AIMessageChunk({ content: "", tool_calls: [{ name: "x", args: {}, id: "1" }] }),
      ],
      citations: [],
    };
    expect(pendingToolCalls(state)[0].args).toEqual({});
  });

  it("同じツールを2回呼んでも別の呼び出しとして返す", () => {
    // グラフはツールループを回すので search_rules → search_rules がありうる。
    // 名前で重複排除すると2回目の tool イベントが出ず、前置きトークンを捨てられない。
    const state = {
      messages: [
        new AIMessageChunk({
          content: "",
          tool_calls: [
            { name: "search_rules", args: { query: "a" }, id: "1" },
            { name: "search_rules", args: { query: "b" }, id: "2" },
          ],
        }),
      ],
      citations: [],
    };
    expect(pendingToolCalls(state).map((c) => c.id)).toEqual(["1", "2"]);
  });

  it("id が無くても呼び出しごとに別のキーになる", () => {
    const state = {
      messages: [
        new AIMessageChunk({
          id: "m1",
          content: "",
          tool_calls: [
            { name: "search_rules", args: {} },
            { name: "search_rules", args: {} },
          ],
        }),
      ],
      citations: [],
    };
    const ids = pendingToolCalls(state).map((c) => c.id);
    expect(new Set(ids).size).toBe(2);
  });

  it("id が無いとき、ループの2周目でも1周目とキーが衝突しない", () => {
    // 固定の接頭辞で補うと 2周目の search_rules が 1周目と同じ鍵になり、
    // streamAgent の重複排除に食われて tool イベントが出なくなる。
    const call = { name: "search_rules", args: {} };
    const round1 = {
      messages: [new HumanMessage("質問"), new AIMessageChunk({ content: "", tool_calls: [call] })],
      citations: [],
    };
    const round2 = {
      messages: [
        new HumanMessage("質問"),
        new AIMessageChunk({ content: "", tool_calls: [call] }),
        new ToolMessage({ content: "結果", tool_call_id: "x", name: "search_rules" }),
        new AIMessageChunk({ content: "", tool_calls: [call] }),
      ],
      citations: [],
    };
    expect(pendingToolCalls(round1)[0].id).not.toBe(pendingToolCalls(round2)[0].id);
  });

  it("ツール呼び出しが無ければ空", () => {
    expect(
      pendingToolCalls({ messages: [new AIMessageChunk({ content: "回答" })], citations: [] }),
    ).toEqual([]);
    expect(pendingToolCalls({ messages: [], citations: [] })).toEqual([]);
  });

  it("末尾が ToolMessage なら空 (実行済み)", () => {
    const state = {
      messages: [new ToolMessage({ content: "結果", tool_call_id: "1", name: "search_rules" })],
      citations: [],
    };
    expect(pendingToolCalls(state)).toEqual([]);
  });
});
