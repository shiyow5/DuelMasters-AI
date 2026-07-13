import type { Context, MiddlewareHandler } from "hono";
import { getSupabase } from "@dm-ai/db";

declare module "hono" {
  interface ContextVariableMap {
    userId: string | null;
  }
}

/** INTERNAL_API_KEY を取得する (Workers=c.env / Node=process.env)。 */
function getInternalApiKey(c: Context): string | undefined {
  const env = c.env as { INTERNAL_API_KEY?: string } | undefined;
  return env?.INTERNAL_API_KEY ?? process.env.INTERNAL_API_KEY;
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
    const configured = getInternalApiKey(c);
    if (!configured || internalKey !== configured) {
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

/**
 * 無認証アクセスを許すか。**既定は false (認証必須)**。
 *
 * E2E とローカル開発は Supabase を構成しないため、ログイン必須のままだと動かない。
 * そこで明示的な opt-out フラグを置く。本番 Worker では設定しない (deploy.yml が
 * wrangler.jsonc への混入を検査する)。`"true"` 以外はすべて認証必須として扱う。
 */
function allowAnonymous(c: Context): boolean {
  const env = c.env as { ALLOW_ANONYMOUS?: string } | undefined;
  return (env?.ALLOW_ANONYMOUS ?? process.env.ALLOW_ANONYMOUS) === "true";
}

/** 正しい内部キーが付いているか (X-User-Id の有無は問わない)。 */
function hasValidInternalKey(c: Context): boolean {
  const key = c.req.header("x-internal-key");
  const configured = getInternalApiKey(c);
  return Boolean(configured) && key === configured;
}

/**
 * API 全体のログイン必須ガード。
 *
 * /api/chat は Gemini を叩くため、無認証で開けておくと**第三者に課金を消費される**。
 * デッキ構築も DB を重く叩く。読み取り系 (ティア表など) も含めて一律に閉じる。
 *
 * bot は X-Internal-Key + X-User-Id で userId が入るので通過する。
 * 一方 POST /api/meta/ingest/url は requireInternal だけで守られており X-User-Id を送らない。
 * userId 必須のままだと requireInternal に到達する前に 401 になり、大会結果の取り込みが
 * 使えなくなる。正しい内部キーが付いていれば userId が無くても通す。
 */
export const requireAuthUnlessAnonymous: MiddlewareHandler = async (c, next) => {
  if (allowAnonymous(c)) return next();
  if (hasValidInternalKey(c)) return next();
  return requireAuth(c, next);
};

/** 内部APIキー必須 (Bot/管理操作。キーが正しくなければ 401) */
export const requireInternal: MiddlewareHandler = async (c, next) => {
  const key = c.req.header("x-internal-key");
  const configured = getInternalApiKey(c);
  if (!configured || key !== configured) {
    return c.json({ error: "内部APIキーが不正です" }, 401);
  }
  return next();
};
