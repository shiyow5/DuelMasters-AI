import type { MiddlewareHandler } from "hono";
import { getSql } from "@dm-ai/db";

/**
 * /api/chat のユーザー単位・日次クォータ (F-1)。
 *
 * rate-limit.ts の分単位の制限 (ユーザー 30回/60秒) だけでは、1日を通して叩き続けると
 * 4万回以上通ってしまい、Gemini の課金か無料枠を1人で食い潰せる (全員が巻き添えになる)。
 * 1日の回数で頭打ちにする。
 *
 * - 数える単位は userId。Web (`supabase:`) も bot (`discord:`) も同じ仕組みで数える
 * - 日付は JST で区切る (利用者は日本。UTC だと朝9時にリセットされて分かりにくい)
 * - カウンタは既存の Postgres (infra/sql/010_chat_daily_usage.sql)。Workers の KV を
 *   増やすより、既に Hyperdrive で繋がっている DB に1テーブル足す方が構成が増えない
 */

/** 1ユーザーが1日に /api/chat を呼べる回数。 */
export const DAILY_CHAT_LIMIT = 100;

/** 超過時の固定文言。回数や残り時間は返さない (仕様を探る材料を与えない)。 */
export const DAILY_QUOTA_EXCEEDED = {
  error: "本日の利用上限に達しました。明日になってから再度お試しください",
} as const;

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** クォータの日付キー (JST の YYYY-MM-DD)。 */
export function quotaDay(now: Date): string {
  return new Date(now.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 当日の回数を1増やし、増やした後の回数を返す。 */
export type ChatUsageCounter = (userId: string, day: string) => Promise<number>;

/**
 * Postgres のカウンタ。**1文の UPSERT で増やして読む** — SELECT してから UPDATE すると
 * 並行リクエストで数え漏れる。
 */
export const incrementChatUsage: ChatUsageCounter = async (userId, day) => {
  const sql = getSql();
  const rows = await sql`
    INSERT INTO chat_daily_usage (user_id, usage_date, count)
    VALUES (${userId}, ${day}, 1)
    ON CONFLICT (user_id, usage_date)
    DO UPDATE SET count = chat_daily_usage.count + 1
    RETURNING count
  `;
  return Number(rows[0].count);
};

/**
 * 日次クォータのミドルウェア。**認証の後**に置くこと (userId が要る)。
 *
 * - POST 以外は数えない (チャットは POST だけ)
 * - userId が無い (ALLOW_ANONYMOUS のローカル開発) なら数えない
 * - カウンタの DB が落ちていたら**通す** (fail-open)。分単位のレート制限は残るうえ、
 *   DB 障害時にチャットを全面停止させるほうが被害が大きい。エラーはログに残す
 */
export function dailyChatQuota(
  counter: ChatUsageCounter = incrementChatUsage,
  now: () => Date = () => new Date(),
): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method !== "POST") return next();
    const userId = c.get("userId");
    if (!userId) return next();

    let count: number;
    try {
      count = await counter(userId, quotaDay(now()));
    } catch (err) {
      console.error("[api] 日次クォータのカウントに失敗 (通過させる):", err);
      return next();
    }
    if (count > DAILY_CHAT_LIMIT) return c.json(DAILY_QUOTA_EXCEEDED, 429);
    return next();
  };
}
