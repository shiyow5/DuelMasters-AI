import { Hono } from "hono";
import { z } from "zod";
import { getSql } from "@dm-ai/db";
import { requireAuth } from "../middleware/auth.js";

/**
 * 会話履歴 (#110)。
 *
 * ## 所有者チェックは SQL で行う
 *
 * 「まず取得して、user_id を比べて、違えば弾く」という分岐は**書き忘れる**。
 * 全ての読み書きを `WHERE ... AND user_id = ${userId}` で絞り、0行なら 404 にする。
 * こうすると所有者チェックを飛ばした経路が構造的に作れない。
 *
 * ## 他人の会話は 403 ではなく 404
 *
 * 403 は「その ID の会話は存在する」ことを漏らす。会話は保存デッキ以上に機微なので、
 * 存在自体を隠す。
 */
const conversationRouter = new Hono();

/** Postgres の uuid 型に不正な文字列を渡すと 22P02 で落ちる。事前に弾いて 404 にする。 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CreateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  mode: z.enum(["rule", "deck", "meta", "integrated"]).optional(),
});

const RenameSchema = z.object({
  title: z.string().trim().min(1).max(200),
});

/**
 * 発言の上限。**このエンドポイントは web からは呼ばれない**が、requireAuth だけで守られた
 * 公開 API なので、ログイン済みなら誰でも直接叩ける。上限が無いと数MB級の本文を書き込み続けて
 * ストレージと egress を食い潰せる。レート制限は回数しか見ていない (サイズは見ない)。
 */
const MAX_CONTENT = 32_000;
const MAX_CITATIONS = 50;
const MAX_TOOL_CALLS = 20;

/** 1会話あたり返す発言数の上限。肥大化した会話を開いた瞬間に全件返さないようにする。 */
export const MAX_MESSAGES_PER_FETCH = 200;

const MessageSchema = z.object({
  // system は受けない。**モデルへの指示を利用者が書き込めてはいけない。**
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(MAX_CONTENT),
  citations: z.array(z.record(z.string(), z.unknown())).max(MAX_CITATIONS).optional(),
  toolCalls: z
    .array(z.object({ name: z.string(), args: z.record(z.string(), z.unknown()) }))
    .max(MAX_TOOL_CALLS)
    .optional(),
});

const FeedbackSchema = z.object({ helpful: z.boolean() });

/** 会話一覧 (自分のもののみ・新しい順)。 */
conversationRouter.get("/", requireAuth, async (c) => {
  const userId = c.get("userId")!;
  const sql = getSql();
  const rows = await sql`
    SELECT c.id, c.title, c.mode, c.created_at, c.updated_at,
           (SELECT count(*)::int FROM conversation_messages m WHERE m.conversation_id = c.id)
             AS message_count
    FROM conversations c
    WHERE c.user_id = ${userId}
    ORDER BY c.updated_at DESC
    LIMIT 100
  `;
  return c.json({ conversations: rows });
});

/** 会話を作る。 */
conversationRouter.post("/", requireAuth, async (c) => {
  const parsed = CreateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "リクエストが不正です" }, 400);

  const userId = c.get("userId")!;
  const { title, mode = "integrated" } = parsed.data;
  const sql = getSql();
  const rows = await sql`
    INSERT INTO conversations (user_id, title, mode)
    VALUES (${userId}, ${title}, ${mode})
    RETURNING id, title, mode, created_at, updated_at
  `;
  return c.json(rows[0], 201);
});

/** 会話を1件取得 (メッセージ込み)。他人のものは 404。 */
conversationRouter.get("/:id", requireAuth, async (c) => {
  const id = c.req.param("id");
  if (!UUID.test(id)) return c.json({ error: "会話が見つかりません" }, 404);

  const userId = c.get("userId")!;
  const sql = getSql();
  const conv = await sql`
    SELECT id, title, mode, created_at, updated_at
    FROM conversations
    WHERE id = ${id} AND user_id = ${userId}
  `;
  if (conv.length === 0) return c.json({ error: "会話が見つかりません" }, 404);

  // **LIMIT を付ける。** 上限が無いと、肥大化した会話を開いた瞬間に全件を一括で返し、
  // Worker の CPU/メモリと DB の egress を食う。直近 N 件を取り、時系列に戻して返す。
  const rows = await sql`
    SELECT m.id, m.role, m.content, m.citations, m.tool_calls, m.created_at, f.helpful
    FROM conversation_messages m
    LEFT JOIN message_feedback f ON f.message_id = m.id
    WHERE m.conversation_id = ${id}
    ORDER BY m.created_at DESC
    LIMIT ${MAX_MESSAGES_PER_FETCH}
  `;
  const messages = rows.reverse();
  return c.json({
    ...conv[0],
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      citations: m.citations ?? undefined,
      toolCalls: m.tool_calls ?? undefined,
      helpful: m.helpful ?? undefined,
      created_at: m.created_at,
    })),
  });
});

/** リネーム。 */
conversationRouter.patch("/:id", requireAuth, async (c) => {
  const id = c.req.param("id");
  if (!UUID.test(id)) return c.json({ error: "会話が見つかりません" }, 404);

  const parsed = RenameSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "リクエストが不正です" }, 400);

  const userId = c.get("userId")!;
  const sql = getSql();
  const rows = await sql`
    UPDATE conversations
    SET title = ${parsed.data.title}, updated_at = NOW()
    WHERE id = ${id} AND user_id = ${userId}
    RETURNING id, title, mode, updated_at
  `;
  if (rows.length === 0) return c.json({ error: "会話が見つかりません" }, 404);
  return c.json(rows[0]);
});

/** 削除 (メッセージも ON DELETE CASCADE で消える)。 */
conversationRouter.delete("/:id", requireAuth, async (c) => {
  const id = c.req.param("id");
  if (!UUID.test(id)) return c.json({ error: "会話が見つかりません" }, 404);

  const userId = c.get("userId")!;
  const sql = getSql();
  const rows = await sql`
    DELETE FROM conversations
    WHERE id = ${id} AND user_id = ${userId}
    RETURNING id
  `;
  if (rows.length === 0) return c.json({ error: "会話が見つかりません" }, 404);
  return c.json({ ok: true });
});

/**
 * メッセージを追記する。
 * 会話の所有者チェックは INSERT ... SELECT の WHERE で行う (取得→比較の分岐を作らない)。
 */
conversationRouter.post("/:id/messages", requireAuth, async (c) => {
  const id = c.req.param("id");
  if (!UUID.test(id)) return c.json({ error: "会話が見つかりません" }, 404);

  const parsed = MessageSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "リクエストが不正です" }, 400);

  const userId = c.get("userId")!;
  const { role, content, citations, toolCalls } = parsed.data;
  const sql = getSql();

  // JSONB は sql.json で渡す。JSON.stringify すると二重エンコードで壊れる。
  const rows = await sql`
    INSERT INTO conversation_messages (conversation_id, role, content, citations, tool_calls)
    SELECT ${id}, ${role}, ${content},
           ${citations ? sql.json(citations as never) : null},
           ${toolCalls ? sql.json(toolCalls as never) : null}
    FROM conversations
    WHERE id = ${id} AND user_id = ${userId}
    RETURNING id, role, content, created_at
  `;
  if (rows.length === 0) return c.json({ error: "会話が見つかりません" }, 404);

  // 一覧の並び順 (updated_at DESC) を最新の発言に追随させる。
  await sql`UPDATE conversations SET updated_at = NOW() WHERE id = ${id} AND user_id = ${userId}`;
  return c.json(rows[0], 201);
});

/**
 * 「役に立った / 立たなかった」。押し直しは上書き (二重登録しない)。
 *
 * **これは eval に直結する。** 低評価が付いた質問は golden set の候補になる。
 * 今まで React の state に持つだけで捨てていた。
 */
conversationRouter.put("/:id/messages/:messageId/feedback", requireAuth, async (c) => {
  const id = c.req.param("id");
  const messageId = c.req.param("messageId");
  if (!UUID.test(id) || !UUID.test(messageId)) {
    return c.json({ error: "メッセージが見つかりません" }, 404);
  }

  const parsed = FeedbackSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "リクエストが不正です" }, 400);

  const userId = c.get("userId")!;
  const sql = getSql();
  // メッセージが「自分の会話に属している」ことを WHERE で担保する。
  const rows = await sql`
    INSERT INTO message_feedback (message_id, user_id, helpful)
    SELECT m.id, ${userId}, ${parsed.data.helpful}
    FROM conversation_messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id = ${messageId} AND m.conversation_id = ${id} AND c.user_id = ${userId}
    ON CONFLICT (message_id) DO UPDATE SET helpful = EXCLUDED.helpful, created_at = NOW()
    RETURNING message_id
  `;
  if (rows.length === 0) return c.json({ error: "メッセージが見つかりません" }, 404);
  return c.json({ ok: true });
});

export { conversationRouter };
