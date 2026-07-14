import { getSql } from "@dm-ai/db";

/**
 * チャットから見た会話の読み書き (#110)。
 *
 * **履歴はサーバ (DB) を正とする。** クライアントが送ってきた履歴を信じると、利用者が文脈を
 * 差し替えてモデルを誘導できてしまう。conversationId が付いていれば、履歴は必ずここから読む。
 *
 * 所有者チェックは全て `WHERE ... AND user_id = ${userId}` で行う。取得してから比較する分岐は
 * 書き忘れるので作らない。見つからなければ 404 相当 (null) を返し、存在自体を漏らさない。
 */

/** 直近の何往復ぶんをモデルに渡すか。長すぎると Gemini のコンテキストとコストが膨らむ。 */
export const HISTORY_LIMIT = 20;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface StoredMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * 会話の履歴を読む。会話が存在しない / 自分のものでなければ null。
 * **null と空配列は違う。** null は「その会話は無い (404)」、[] は「まだ発言が無い」。
 */
export async function loadHistory(
  conversationId: string,
  userId: string,
): Promise<StoredMessage[] | null> {
  if (!UUID.test(conversationId)) return null;
  const sql = getSql();

  const conv = await sql`
    SELECT id FROM conversations WHERE id = ${conversationId} AND user_id = ${userId}
  `;
  if (conv.length === 0) return null;

  // 直近 HISTORY_LIMIT 件を取り、時系列に戻す。
  const rows = await sql`
    SELECT role, content
    FROM conversation_messages
    WHERE conversation_id = ${conversationId}
    ORDER BY created_at DESC
    LIMIT ${HISTORY_LIMIT}
  `;
  return rows
    .map((r) => ({ role: r.role as "user" | "assistant", content: r.content as string }))
    .reverse();
}

/**
 * 発言を1件保存し、その id を返す。所有者でなければ null (何も書かない)。
 *
 * **id を返すのが重要。** これが無いと、利用者は回答を受け取った直後に「役に立った」を
 * 押せない (クライアントが発言 ID を知らないため)。フィードバックは反応した瞬間にしか
 * 取れないシグナルなので、そこを取りこぼしてはいけない。
 */
export async function appendMessage(
  conversationId: string,
  userId: string,
  msg: {
    role: "user" | "assistant";
    content: string;
    citations?: unknown[];
    toolCalls?: unknown[];
  },
): Promise<string | null> {
  if (!UUID.test(conversationId)) return null;
  const sql = getSql();

  // JSONB は sql.json で渡す。JSON.stringify すると二重エンコードで壊れる。
  const rows = await sql`
    INSERT INTO conversation_messages (conversation_id, role, content, citations, tool_calls)
    SELECT ${conversationId}, ${msg.role}, ${msg.content},
           ${msg.citations ? sql.json(msg.citations as never) : null},
           ${msg.toolCalls ? sql.json(msg.toolCalls as never) : null}
    FROM conversations
    WHERE id = ${conversationId} AND user_id = ${userId}
    RETURNING id
  `;
  if (rows.length === 0) return null;

  await sql`
    UPDATE conversations SET updated_at = NOW()
    WHERE id = ${conversationId} AND user_id = ${userId}
  `;
  return rows[0].id as string;
}
