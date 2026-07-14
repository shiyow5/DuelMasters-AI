import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { ChatRequestSchema } from "@dm-ai/core";
import { runAgent, streamAgent, type AgentOutput } from "@dm-ai/agent";
import { loadHistory, appendMessage, type StoredMessage } from "../conversation-store.js";

const chatRouter = new Hono();

/**
 * 会話 ID があれば履歴を DB から読み、利用者の発言を保存する (#110)。
 *
 * **履歴はサーバを正とする。** クライアントが送ってきた history は conversationId がある限り
 * 使わない。信じると利用者が文脈を差し替えてモデルを誘導できる。
 *
 * 戻り値の `history` は agent に渡すもの。会話が他人のもの / 存在しなければ `notFound`。
 */
async function beginTurn(
  conversationId: string | undefined,
  userId: string | null,
  message: string,
  clientHistory: StoredMessage[],
): Promise<{ notFound: true } | { notFound: false; history: StoredMessage[] }> {
  if (!conversationId || !userId) return { notFound: false, history: clientHistory };

  const history = await loadHistory(conversationId, userId);
  if (history === null) return { notFound: true };

  // 利用者の発言は**エージェントを走らせる前に**保存する。生成が落ちても質問は残す。
  await appendMessage(conversationId, userId, { role: "user", content: message });
  return { notFound: false, history };
}

/**
 * 回答を保存し、その発言 id を返す。引用とツール呼び出しも残す
 * (後から根拠を辿れないと保存する意味が薄い)。
 *
 * **id をクライアントへ返す。** これが無いと、利用者は回答を受け取った直後に「役に立った」を
 * 押せない。フィードバックは反応した瞬間にしか取れないシグナルなので取りこぼさない。
 */
async function saveAnswer(
  conversationId: string | undefined,
  userId: string | null,
  out: AgentOutput,
): Promise<string | null> {
  if (!conversationId || !userId) return null;
  return appendMessage(conversationId, userId, {
    role: "assistant",
    content: out.response,
    citations: out.citations,
    toolCalls: out.toolCalls,
  });
}

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
  const { message, mode, history, format, conversationId } = parsed.data;
  const userId = c.get("userId");

  const turn = await beginTurn(conversationId, userId, message, history);
  if (turn.notFound) return c.json({ error: "会話が見つかりません" }, 404);

  const result = await runAgent({ message, mode, history: turn.history, format });
  const messageId = await saveAnswer(conversationId, userId, result);
  return c.json(messageId ? { ...result, messageId } : result);
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
  const { message, mode, history, format, conversationId } = parsed.data;
  const userId = c.get("userId");

  // 会話の所有者チェックと利用者発言の保存は**ストリームを開く前**に行う。
  // 開いた後だと HTTP ステータスを変えられず、404 を返せない。
  const turn = await beginTurn(conversationId, userId, message, history);
  if (turn.notFound) return c.json({ error: "会話が見つかりません" }, 404);

  return streamSSE(c, async (stream) => {
    try {
      for await (const ev of streamAgent({ message, mode, history: turn.history, format })) {
        const { type, ...payload } = ev;
        await stream.writeSSE({ event: type, data: JSON.stringify(payload) });
        // 回答は確定した時点で保存する。**クライアントに保存させない** — 利用者が
        // ストリーム途中でタブを閉じると回答が失われ、質問だけが残ってしまう。
        if (ev.type === "done") {
          const messageId = await saveAnswer(conversationId, userId, ev.result);
          // 保存した発言 ID を伝える。これが無いと利用者は受け取った直後に 👍 を押せない。
          if (messageId) {
            await stream.writeSSE({ event: "saved", data: JSON.stringify({ messageId }) });
          }
        }
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
