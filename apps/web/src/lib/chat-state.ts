import type { Message } from "./types";
import type { ChatStreamEvent } from "./api";
import { toolLabel, phaseLabel } from "./tools";

/**
 * ストリームのイベント1件を、応答中の assistant メッセージへ適用する (純関数)。
 *
 * ここが進行表示の要。**イベントの届く順序は一定ではない**ので、UI のちらつきや固着は
 * すべてこの関数の分岐で防ぐ。実測した順序:
 *
 *   rule       : phase{retrieve} → token… → phase{agent} → done
 *   integrated : phase{agent} → tool{args} → phase{tools} → token… → done
 *
 * **`token` は進行表示専用。最終的な回答は必ず `done` の `result.response` を使う** (#91)。
 * ストリームが途中で乱れても done さえ届けば正しい回答が出る (段階的強化)。
 */
export function applyChatEvent(msg: Message, ev: ChatStreamEvent): Message {
  switch (ev.type) {
    case "token":
      return { ...msg, content: msg.content + ev.text };

    case "phase": {
      const label = phaseLabel(ev.node);
      // トークンが流れ始めたあとに phase が届くことがある (integrated の phase{agent})。
      // ここで status を更新すると、**回答が表示されている最中に進行表示へ巻き戻り**、
      // 回答が消えたように見える。content が空のとき = まだ回答が出ていないときだけ更新する。
      if (!label || msg.content !== "") return msg;
      return { ...msg, status: label };
    }

    case "tool":
      // エージェントはツールを呼ぶ前に前置きを喋ることがある。その分のトークンは捨てて
      // 「今なにをしているか」に差し替える (最終的な回答は done で確定するので消して問題ない)。
      return { ...msg, content: "", status: toolLabel(ev.name, ev.args ?? {}) };

    case "done":
      return {
        ...msg,
        content: ev.result.response,
        citations: ev.result.citations,
        toolCalls: ev.result.toolCalls,
        streaming: false,
        status: undefined,
      };

    case "error":
      return { ...msg, content: ev.message, streaming: false, status: undefined, error: true };
  }
}
