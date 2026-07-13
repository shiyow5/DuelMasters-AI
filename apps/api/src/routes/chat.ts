import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { ChatRequestSchema } from "@dm-ai/core";
import { runAgent, streamAgent } from "@dm-ai/agent";

const chatRouter = new Hono();

/**
 * チャットエンドポイント。リクエストを検証し、LangGraph エージェント (@dm-ai/agent) に委譲する。
 * レスポンス形 (response / citations / toolCalls / mode) はエージェントが api 互換で返す。
 */
chatRouter.post("/", async (c) => {
  const raw = await c.req.json().catch(() => null);
  const parsed = ChatRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json(
      {
        error: "リクエストが不正です",
        details: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      },
      400,
    );
  }
  const { message, mode, history, format } = parsed.data;
  const result = await runAgent({ message, mode, history, format });
  return c.json(result);
});

/**
 * チャット (SSE ストリーミング)。
 *
 * エージェントはツールを何本も回すので、完成した回答を一括で返すと十数秒の無言になる。
 * トークンとツール実行の進捗を逐次流す。
 *
 * イベント:
 * - `token` … 回答の断片。**進行表示専用**。
 * - `tool`  … ツール実行開始。クライアントはここまでの token を捨てる
 *              (エージェントがツールを呼ぶ前に前置きを喋ることがあるため)。
 * - `done`  … 確定結果。POST /api/chat と同じ形 (response/citations/toolCalls/mode)。
 *              **表示する回答は必ずこれを使う。** ストリームが乱れても最終結果は正しくなる。
 * - `error` … エージェントが落ちた。
 */
chatRouter.post("/stream", async (c) => {
  const raw = await c.req.json().catch(() => null);
  const parsed = ChatRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json(
      {
        error: "リクエストが不正です",
        details: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      },
      400,
    );
  }
  const { message, mode, history, format } = parsed.data;

  return streamSSE(c, async (stream) => {
    try {
      for await (const ev of streamAgent({ message, mode, history, format })) {
        const { type, ...payload } = ev;
        await stream.writeSSE({ event: type, data: JSON.stringify(payload) });
      }
    } catch (err) {
      console.error("[api/chat] ストリーミング中にエラー:", err);
      // ヘッダは送信済みなので HTTP ステータスは変えられない。error イベントで伝える。
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ message: "回答の生成に失敗しました" }),
      });
    }
  });
});

export { chatRouter };
