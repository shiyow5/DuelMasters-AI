import { describe, it, expect } from "vitest";
import { applyChatEvent } from "../src/lib/chat-state.js";
import type { Message } from "../src/lib/types.js";

/** ストリーミング中の assistant バブル (送信直後の状態)。 */
const streaming = (over: Partial<Message> = {}): Message => ({
  role: "assistant",
  content: "",
  streaming: true,
  status: "質問を読み取っています",
  ...over,
});

describe("applyChatEvent", () => {
  describe("token", () => {
    it("トークンを継ぎ足す", () => {
      const m = applyChatEvent(streaming({ content: "S・トリ" }), {
        type: "token",
        text: "ガーは",
      });
      expect(m.content).toBe("S・トリガーは");
    });
  });

  describe("tool", () => {
    it("引数まで含んだ進行表示に差し替える", () => {
      const m = applyChatEvent(streaming(), {
        type: "tool",
        name: "search_rules",
        args: { query: "S・トリガー 任意" },
      });
      expect(m.status).toBe("ルールを検索しています: 「S・トリガー 任意」");
    });

    it("ツール実行前の前置きトークンを捨てる", () => {
      // エージェントはツールを呼ぶ前に「確認しますね」等を喋ることがある。
      // これを残すと、その前置きが回答の一部として画面に残ってしまう。
      const m = applyChatEvent(streaming({ content: "確認しますね。" }), {
        type: "tool",
        name: "search_rules",
        args: { query: "x" },
      });
      expect(m.content).toBe("");
    });

    it("args が無くても落ちない", () => {
      const m = applyChatEvent(streaming(), { type: "tool", name: "search_rules" });
      expect(m.status).toBe("ルールを検索しています");
    });
  });

  describe("phase", () => {
    it("回答が始まる前なら進行表示を更新する", () => {
      const m = applyChatEvent(streaming(), { type: "phase", node: "tools" });
      expect(m.status).toBe("検索結果を読んでいます");
    });

    it("トークンが流れ始めたあとの phase は無視する", () => {
      // これを無視しないと、**回答が表示されている最中に進行表示へ巻き戻り**、
      // 回答が消えたように見える。実際 integrated では token のあとに phase{agent} が届く。
      const m = applyChatEvent(streaming({ content: "はい、任意です。" }), {
        type: "phase",
        node: "tools",
      });
      expect(m.status).toBe("質問を読み取っています"); // 変わらない
      expect(m.content).toBe("はい、任意です。"); // 消えない
    });

    it("agent / finalize では文言を変えない (直後にトークンが流れ始めるため)", () => {
      const before = streaming();
      expect(applyChatEvent(before, { type: "phase", node: "agent" })).toEqual(before);
      expect(applyChatEvent(before, { type: "phase", node: "finalize" })).toEqual(before);
    });

    it("知らないノードでも壊れない", () => {
      const before = streaming();
      expect(applyChatEvent(before, { type: "phase", node: "brand_new_node" })).toEqual(before);
    });
  });

  describe("done", () => {
    it("回答は done の response で確定する (token の蓄積は使わない)", () => {
      // #91 の設計原則。token はあくまで進行表示で、途中で乱れても done さえ届けば正しい回答が出る。
      const m = applyChatEvent(streaming({ content: "途中まで流れた壊れたテキスト" }), {
        type: "done",
        result: { response: "これが正しい回答です", citations: [{ text: "113.6" } as never] },
      });
      expect(m.content).toBe("これが正しい回答です");
      expect(m.citations).toHaveLength(1);
      expect(m.streaming).toBe(false);
      expect(m.status).toBeUndefined();
    });
  });

  describe("error", () => {
    it("エラーは赤字で出し、ストリーミングを終える", () => {
      const m = applyChatEvent(streaming({ content: "途中" }), {
        type: "error",
        message: "生成に失敗しました",
      });
      expect(m.content).toBe("生成に失敗しました");
      expect(m.error).toBe(true);
      expect(m.streaming).toBe(false);
      expect(m.status).toBeUndefined();
    });
  });

  describe("ツールループ (agent → tools → agent → tools)", () => {
    it("2周しても進行表示が固まらず、最後は done の回答で終わる", () => {
      // グラフはツールを何度も呼ぶ。各周で content がリセットされ、status が更新され、
      // 最後に done が来る、という流れが崩れないことを通しで確かめる。
      const events = [
        { type: "phase", node: "agent" },
        { type: "tool", name: "search_rules", args: { query: "1周目" } },
        { type: "phase", node: "tools" },
        { type: "token", text: "前置き" },
        { type: "phase", node: "agent" },
        { type: "tool", name: "search_cards", args: { query: "2周目" } },
        { type: "phase", node: "tools" },
        { type: "token", text: "回答の" },
        { type: "token", text: "本文" },
        { type: "done", result: { response: "最終回答" } },
      ] as const;

      let m = streaming();
      const statuses: Array<string | undefined> = [];
      for (const ev of events) {
        m = applyChatEvent(m, ev as never);
        statuses.push(m.status);
      }

      // 2周目のツールでも「何を」検索しているかが出る
      expect(statuses).toContain("ルールを検索しています: 「1周目」");
      expect(statuses).toContain("カードを検索しています: 「2周目」");
      // 最終状態
      expect(m.content).toBe("最終回答");
      expect(m.streaming).toBe(false);
      expect(m.status).toBeUndefined();
    });
  });
});
