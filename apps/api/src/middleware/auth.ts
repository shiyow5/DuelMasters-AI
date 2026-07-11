import type { MiddlewareHandler } from "hono";
import { getSupabase } from "@dm-ai/db";

declare module "hono" {
  interface ContextVariableMap {
    userId: string | null;
  }
}

/**
 * 認証を試みて userId を設定する (無認証でも通す)。
 * - X-Internal-Key 一致: userId = X-User-Id (Bot/内部サービス)
 * - Authorization: Bearer <token>: Supabase で検証し userId = supabase:<id>
 */
export const optionalAuth: MiddlewareHandler = async (c, next) => {
  c.set("userId", null);

  const internalKey = c.req.header("x-internal-key");
  if (internalKey) {
    if (!process.env.INTERNAL_API_KEY || internalKey !== process.env.INTERNAL_API_KEY) {
      return c.json({ error: "内部APIキーが不正です" }, 401);
    }
    // X-User-Id は X-Internal-Key が正しい場合のみ信用する
    c.set("userId", c.req.header("x-user-id") ?? null);
    return next();
  }

  const bearer = c.req.header("authorization");
  if (bearer?.startsWith("Bearer ")) {
    const token = bearer.slice("Bearer ".length);
    const { data, error } = await getSupabase().auth.getUser(token);
    if (error || !data.user) return c.json({ error: "認証に失敗しました" }, 401);
    c.set("userId", `supabase:${data.user.id}`);
  }

  return next();
};

/** 認証必須 (userId が無ければ 401) */
export const requireAuth: MiddlewareHandler = async (c, next) => {
  if (!c.get("userId")) return c.json({ error: "ログインが必要です" }, 401);
  return next();
};

/** 内部APIキー必須 (Bot/管理操作。キーが正しくなければ 401) */
export const requireInternal: MiddlewareHandler = async (c, next) => {
  const key = c.req.header("x-internal-key");
  if (!process.env.INTERNAL_API_KEY || key !== process.env.INTERNAL_API_KEY) {
    return c.json({ error: "内部APIキーが不正です" }, 401);
  }
  return next();
};
