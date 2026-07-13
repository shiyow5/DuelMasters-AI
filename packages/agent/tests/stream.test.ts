import { describe, it, expect } from "vitest";
import { AIMessageChunk, ToolMessage, HumanMessage } from "@langchain/core/messages";
import { chunkText, pendingToolCalls } from "../src/index.js";

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
  it("末尾 AIMessage のツール呼び出しを ID つきで返す", () => {
    const state = {
      messages: [
        new HumanMessage("質問"),
        new AIMessageChunk({
          content: "",
          tool_calls: [
            { name: "search_rules", args: {}, id: "1" },
            { name: "search_cards", args: {}, id: "2" },
          ],
        }),
      ],
      citations: [],
    };
    expect(pendingToolCalls(state)).toEqual([
      { id: "1", name: "search_rules" },
      { id: "2", name: "search_cards" },
    ]);
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
