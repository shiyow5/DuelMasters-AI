import { describe, it, expect } from "vitest";
import { applyChatEvent } from "@/lib/chat-state";
import { toolErrorLabel } from "@/lib/tools";
import type { Message } from "@/lib/types";

/**
 * ツール失敗の可視化 (#109)。
 *
 * 失敗を握り潰すと、**データで裏付けられていない回答が「普通の回答」に見える**。
 * #112 では全ツールが死んでいたのに、利用者には「たまに調子が悪い」としか見えなかった。
 */

const streaming: Message = { role: "assistant", content: "", streaming: true };

describe("applyChatEvent の toolError", () => {
  it("失敗したツールを積む", () => {
    const msg = applyChatEvent(streaming, { type: "toolError", name: "search_cards" });
    expect(msg.toolFailures).toEqual(["search_cards"]);
  });

  it("複数の失敗を積める", () => {
    let msg = applyChatEvent(streaming, { type: "toolError", name: "search_cards" });
    msg = applyChatEvent(msg, { type: "toolError", name: "search_rules" });
    expect(msg.toolFailures).toEqual(["search_cards", "search_rules"]);
  });

  it("done がサーバーの確定リストで上書きする", () => {
    // done が真実。ストリーム中に積んだものは、サーバーが報告しなければ消す
    // (リトライで成功していることがある)。
    let msg = applyChatEvent(streaming, { type: "toolError", name: "search_cards" });
    msg = applyChatEvent(msg, {
      type: "done",
      result: { response: "回答", toolFailures: ["search_rules"] },
    });
    expect(msg.toolFailures).toEqual(["search_rules"]);
  });

  it("done で失敗が報告されなければ、積んだものも消える", () => {
    let msg = applyChatEvent(streaming, { type: "toolError", name: "search_cards" });
    msg = applyChatEvent(msg, { type: "done", result: { response: "回答" } });
    expect(msg.toolFailures).toBeUndefined();
  });
});

describe("toolErrorLabel", () => {
  it("何が取れなかったかと、回答の性質を伝える", () => {
    // 「エラーが発生しました」で終わらせない。**この回答は信じてよいのか**を伝える。
    const label = toolErrorLabel(["search_cards"]);
    expect(label).toContain("カード検索");
    expect(label).toContain("裏付けられていません");
  });

  it("同じツールが複数回失敗しても1つにまとめる", () => {
    expect(toolErrorLabel(["search_cards", "search_cards"])).toBe(toolErrorLabel(["search_cards"]));
  });

  it("複数のツールを並べる", () => {
    const label = toolErrorLabel(["search_cards", "search_rules"]);
    expect(label).toContain("カード検索");
    expect(label).toContain("ルール検索");
  });
});
