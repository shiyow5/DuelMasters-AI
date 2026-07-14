import { describe, it, expect } from "vitest";
import { toMessages, canSendFeedback } from "@/lib/conversation-state";
import { titleFromMessage, TITLE_MAX } from "@/lib/conversations";
import { applyChatEvent } from "@/lib/chat-state";
import type { Message } from "@/lib/types";

describe("titleFromMessage (会話タイトルの自動生成)", () => {
  it("最初の行から作る", () => {
    expect(titleFromMessage("S・トリガーの処理順を教えて")).toBe("S・トリガーの処理順を教えて");
  });

  it("長い質問は省略する", () => {
    const long = "あ".repeat(TITLE_MAX + 20);
    const title = titleFromMessage(long);
    expect(title.length).toBe(TITLE_MAX + 1); // 本文 + 省略記号
    expect(title.endsWith("…")).toBe(true);
  });

  it("複数行なら最初の非空行を使う", () => {
    // デッキ評価は「次のデッキを評価してください:\n4 ボルシャック…」のように複数行で来る。
    // 改行ごと入れるとサイドバーが崩れる。
    expect(titleFromMessage("\n\n次のデッキを評価して\n4 ボルシャック・ドラゴン")).toBe(
      "次のデッキを評価して",
    );
  });

  it("空でも落ちない", () => {
    expect(titleFromMessage("   \n  ")).toBe("新しい会話");
  });
});

describe("canSendFeedback (👍 を押せるか)", () => {
  const base: Message = { id: "m1", role: "assistant", content: "回答" };

  it("会話 ID と発言 ID が揃っていれば押せる", () => {
    expect(canSendFeedback(base, "c1")).toBe(true);
  });

  it("**保存されていない発言には押せない** (どの発言への評価か指定できない)", () => {
    expect(canSendFeedback({ ...base, id: undefined }, "c1")).toBe(false);
  });

  it("会話が無ければ押せない (未ログインで保存されていない)", () => {
    expect(canSendFeedback(base, null)).toBe(false);
  });

  it("ストリーミング中は押せない (回答が確定していない)", () => {
    expect(canSendFeedback({ ...base, streaming: true }, "c1")).toBe(false);
  });

  it("自分の発言には押せない", () => {
    expect(canSendFeedback({ ...base, role: "user" }, "c1")).toBe(false);
  });
});

describe("toMessages (DB の発言を UI の形に)", () => {
  it("引用・ツール・評価を引き継ぐ", () => {
    const [m] = toMessages([
      {
        id: "m1",
        role: "assistant",
        content: "回答",
        citations: [{ text: "条文", article: "113.6" }],
        toolCalls: [{ name: "search_rules", args: { query: "S" } }],
        helpful: true,
        created_at: "2026-07-14T09:30:00.000Z",
      },
    ]);
    expect(m.id).toBe("m1");
    expect(m.citations).toHaveLength(1);
    expect(m.toolCalls?.[0].name).toBe("search_rules");
    expect(m.helpful).toBe(true);
    expect(m.timestamp).toBeTruthy();
  });

  it("評価が無ければ undefined (false と区別する)", () => {
    // helpful=false は「役に立たなかった」。未評価と混同してはいけない。
    const [m] = toMessages([
      { id: "m1", role: "user", content: "質問", created_at: "2026-07-14T09:30:00.000Z" },
    ]);
    expect(m.helpful).toBeUndefined();
  });
});

describe("applyChatEvent の saved イベント (#110)", () => {
  it("saved で発言 ID が付き、👍 を押せるようになる", () => {
    // done の直後に saved が届く。これが無いと「回答は出たが評価できない」状態になり、
    // **反応した瞬間にしか取れないシグナルを取りこぼす**。
    let msg: Message = { role: "assistant", content: "", streaming: true };
    msg = applyChatEvent(msg, {
      type: "done",
      result: { response: "確定した回答" },
    });
    expect(canSendFeedback(msg, "c1")).toBe(false); // まだ ID が無い

    msg = applyChatEvent(msg, { type: "saved", messageId: "m9" });
    expect(msg.id).toBe("m9");
    expect(msg.content).toBe("確定した回答"); // 本文は壊さない
    expect(canSendFeedback(msg, "c1")).toBe(true);
  });
});
