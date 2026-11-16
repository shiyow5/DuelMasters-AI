import type { Context } from "hono";
import { getSqlState, toDbErrorResponse, toSafeDbErrorLog } from "@dm-ai/db";

/**
 * 予期しない例外の共通ハンドリング (app.onError)。クライアントには汎用文言だけを返す。
 *
 * DB 例外 (SQLSTATE が取れるもの) は、ログにも固定の要約 (種別と SQLSTATE) だけを出す。
 * drizzle の例外は message / params / query に入力値を、cause に元のドライバ例外を持つため、
 * 例外本体をそのままログに出すと入力値がサーバーログに残る。
 * 一意制約違反 (23505) は 409、それ以外は従来どおり 500。
 *
 * DB 以外の例外は従来どおり例外本体をサーバーログに出す (原因調査のため)。
 */
export function handleAppError(err: unknown, c: Context): Response {
  if (getSqlState(err) !== null) {
    console.error(
      `[api] ${c.req.method} ${c.req.path} で DB エラー:`,
      JSON.stringify(toSafeDbErrorLog(err)),
    );
    const { status, body } = toDbErrorResponse(err);
    return c.json(body, status);
  }
  console.error(`[api] ${c.req.method} ${c.req.path} で未処理エラー:`, err);
  return c.json({ error: "内部エラーが発生しました" }, 500);
}
