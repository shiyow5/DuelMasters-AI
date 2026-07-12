import { Hono } from "hono";
import { ChatRequestSchema } from "@dm-ai/core";
import { runAgent } from "@dm-ai/agent";

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

export { chatRouter };
