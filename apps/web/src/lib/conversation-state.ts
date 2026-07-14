import type { Message } from "./types";
import type { StoredMessage } from "./conversations";

/**
 * 会話の状態遷移 (純関数)。UI から切り出してテストできるようにする (#110)。
 *
 * ここを間違えると「別の会話を開いたのに前の会話の発言が残る」「保存前の会話に
 * メッセージ ID が付いていないのに 👍 を送ろうとする」といった壊れ方をする。
 */

/** DB から読んだ発言を UI の Message に変換する。 */
export function toMessages(stored: StoredMessage[]): Message[] {
  return stored.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    citations: m.citations,
    toolCalls: m.toolCalls,
    helpful: m.helpful,
    timestamp: new Date(m.created_at).toLocaleTimeString("ja-JP", {
      hour: "2-digit",
      minute: "2-digit",
    }),
  }));
}

/**
 * 👍 を送れるか。
 *
 * **保存されていない発言には送れない。** ストリーミング直後の assistant メッセージは
 * サーバー側で保存されているが、クライアントはその ID を知らない (done イベントに
 * 含まれない)。会話を読み直すまでは押せないので、ボタンを出さない。
 */
export function canSendFeedback(msg: Message, conversationId: string | null): boolean {
  return Boolean(conversationId) && Boolean(msg.id) && msg.role === "assistant" && !msg.streaming;
}
