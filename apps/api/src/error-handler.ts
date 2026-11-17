import type { Context } from "hono";
import { getSqlState, toDbErrorResponse, toSafeErrorLog } from "@dm-ai/db";

/**
 * 予期しない例外の共通ハンドリング (app.onError)。クライアントには汎用文言だけを返す。
 *
 * ログには固定の要約 (toSafeErrorLog) だけを出す。DB 例外は種別と SQLSTATE、
 * それ以外は例外の種別名。どちらにも errorId を付ける。
 * 例外の message / stack / cause は入力値・SQL・接続情報を含みうるので出さない
 * (drizzle の例外は message / params / query に入力値を、cause に元のドライバ例外を持つ)。
 * 一意制約違反 (23505) は 409、それ以外は 500。
 */
export function handleAppError(err: unknown, c: Context): Response {
  const log = JSON.stringify(toSafeErrorLog(err));
  if (getSqlState(err) !== null) {
    console.error(`[api] ${c.req.method} ${c.req.path} で DB エラー:`, log);
    const { status, body } = toDbErrorResponse(err);
    return c.json(body, status);
  }
  console.error(`[api] ${c.req.method} ${c.req.path} で未処理エラー:`, log);
  return c.json({ error: "内部エラーが発生しました" }, 500);
}
