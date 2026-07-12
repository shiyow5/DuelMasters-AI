import { Hono } from "hono";
import { getSql } from "@dm-ai/db";
import { UserSettingsRequestSchema } from "@dm-ai/core";
import { requireAuth } from "../middleware/auth.js";

const userRouter = new Hono();

/** ユーザー設定取得 (行が無ければ original) */
userRouter.get("/settings", requireAuth, async (c) => {
  const userId = c.get("userId")!;
  const sql = getSql();
  const rows = await sql`
    SELECT format FROM user_settings WHERE user_id = ${userId}
  `;
  return c.json({ format: rows.length > 0 ? rows[0].format : "original" });
});

/** ユーザー設定更新 (UPSERT) */
userRouter.put("/settings", requireAuth, async (c) => {
  const raw = await c.req.json().catch(() => null);
  const parsed = UserSettingsRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json(
      {
        error: "リクエストが不正です",
        details: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      },
      400,
    );
  }
  const userId = c.get("userId")!;
  const sql = getSql();
  await sql`
    INSERT INTO user_settings (user_id, format, updated_at)
    VALUES (${userId}, ${parsed.data.format}, NOW())
    ON CONFLICT (user_id) DO UPDATE SET format = EXCLUDED.format, updated_at = NOW()
  `;
  return c.json({ format: parsed.data.format });
});

export { userRouter };
