/**
 * DB 例外の正規化 (SQLSTATE の取り出しと分類)。
 *
 * drizzle-orm 0.44 以降は、クエリ失敗を `DrizzleQueryError` で包んで投げる。
 * ドライバ (postgres.js) の `PostgresError` は `cause` に入り、例外直下の `code` は無い。
 * 0.38 系や postgres.js を直接使う経路では、例外直下に `code` がある。
 * ここでは両方の形を受け付け、SQLSTATE を 1 つに決める。
 *
 * 優先順位: `cause.code` → 直下の `code`。
 *   両方が SQLSTATE 形式で値が食い違うときは `cause.code` を採る。`cause` 側がドライバの
 *   元例外 (= DB が実際に返した値) で、直下の値はラッパー側の付加情報にすぎないため。
 *   `cause` は 1 段だけ見る。たどらないので、循環した `cause` でも止まる。
 *
 *   `cause` を 2 段以上ネストして包んだ例外 (例: アプリ側で DrizzleQueryError をさらに
 *   `new Error(..., { cause })` で包んだもの) からは SQLSTATE を取れず、null になる。
 *   その場合 apps/api の onError は DB 以外の例外として扱い、種別名と errorId だけをログに出す
 *   (toSafeErrorLog)。tests/errors.test.ts で固定している。
 *
 * 分類に使うのは SQLSTATE 形式 (英大文字・数字 5 文字) の文字列だけ。
 * 5 文字英大文字の `code` を持つ DB 以外の例外 (Node の `EPIPE` 等) も SQLSTATE として扱う
 * (応答は同じ 500 / 同一本文で、ログが要約になるだけ)。
 * message の部分一致では分類しない (入力値や翻訳で文言が変わり、誤判定するため)。
 *
 * ログと HTTP 応答には、ここで定めた固定の識別子・文言と検証済みの SQLSTATE だけを出す。
 * 元例外・message・params・query・cause・stack は、入力値や接続情報を含みうるので出さない。
 */

/** 一意制約違反 (unique_violation) の SQLSTATE。 */
export const SQLSTATE_UNIQUE_VIOLATION = "23505";

const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;

/** 分類結果。ログ・応答に出してよい固定の識別子。 */
export type DbErrorKind = "unique_violation" | "unknown";

/**
 * プロパティを安全に読む。オブジェクト以外は undefined。
 * getter や Proxy が throw しても、ここで握りつぶして undefined にする。
 */
function readProp(value: unknown, key: string): unknown {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return undefined;
  }
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function asSqlState(value: unknown): string | null {
  return typeof value === "string" && SQLSTATE_PATTERN.test(value) ? value : null;
}

/**
 * 例外から SQLSTATE を取り出す。見つからない・形式が不正なら null。
 * どんな値を渡しても throw しない。
 */
export function getSqlState(err: unknown): string | null {
  return asSqlState(readProp(readProp(err, "cause"), "code")) ?? asSqlState(readProp(err, "code"));
}

/** 例外を分類する。どんな値を渡しても throw しない。 */
export function classifyDbError(err: unknown): DbErrorKind {
  return getSqlState(err) === SQLSTATE_UNIQUE_VIOLATION ? "unique_violation" : "unknown";
}

/** 一意制約違反 (23505) か。 */
export function isUniqueViolation(err: unknown): boolean {
  return classifyDbError(err) === "unique_violation";
}

/**
 * ログに出してよい DB 例外の要約。値は固定の識別子と検証済み SQLSTATE だけ。
 * 制約名 (constraint_name) は内部スキーマ構造をログ閲覧者に伝えるので出さない
 * (#271/#272 事後セキュリティレビュー Low)。
 */
export interface SafeDbErrorLog {
  event: "db_error";
  kind: DbErrorKind;
  sqlstate: string | null;
}

/**
 * 例外をログ用の要約にする。元例外の message・params・query・cause・stack・detail・
 * constraint_name は含めない。
 */
export function toSafeDbErrorLog(err: unknown): SafeDbErrorLog {
  return {
    event: "db_error",
    kind: classifyDbError(err),
    sqlstate: getSqlState(err),
  };
}

/** ログ用の例外種別として採用する形式 (JS の識別子相当、64 文字以内)。 */
const ERROR_NAME_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;

/**
 * 例外の種別名を返す。`name` が識別子形式の文字列ならそれ、そうでなければ固定値。
 * Error 以外 (文字列・数値など) が throw された場合は typeof を返す。どんな値でも throw しない。
 * `name` は書き換え可能なので、形式に合わないもの (入力値が入りうる) は採用しない。
 */
export function getErrorName(err: unknown): string {
  if (err === null || (typeof err !== "object" && typeof err !== "function")) {
    return err === null ? "null" : typeof err;
  }
  const name = readProp(err, "name");
  return typeof name === "string" && ERROR_NAME_PATTERN.test(name) ? name : "UnknownError";
}

/**
 * DB 以外も含めた、ログに出してよい例外の要約。
 * DB 例外 (SQLSTATE が取れるもの) は toSafeDbErrorLog の内容、それ以外は種別名だけ。
 * どちらも errorId (呼び出しごとの乱数 ID) を付け、同一障害の複数ログ行を突き合わせられるようにする。
 * 元例外の message・stack・cause は、入力値や接続情報を含みうるので出さない。
 */
export type SafeErrorLog =
  (SafeDbErrorLog & { errorId: string }) | { event: "error"; name: string; errorId: string };

/** 例外をログ用の要約にする。どんな値を渡しても throw しない。 */
export function toSafeErrorLog(err: unknown, errorId: string = crypto.randomUUID()): SafeErrorLog {
  if (getSqlState(err) !== null) return { ...toSafeDbErrorLog(err), errorId };
  return { event: "error", name: getErrorName(err), errorId };
}

/** HTTP 応答に使う固定の本文。kind ごとに決め打ちで、例外の内容は入れない。 */
export interface DbErrorResponse {
  status: 409 | 500;
  body: { error: string };
}

/** API の共通エラー応答 (apps/api の onError) と同じ文言・形。 */
export const DB_INTERNAL_ERROR_MESSAGE = "内部エラーが発生しました";
export const DB_CONFLICT_ERROR_MESSAGE = "同じデータが既に登録されています";

/** 例外を HTTP 応答 (ステータスと本文) にする。本文は毎回新しいオブジェクトを返す。 */
export function toDbErrorResponse(err: unknown): DbErrorResponse {
  return classifyDbError(err) === "unique_violation"
    ? { status: 409, body: { error: DB_CONFLICT_ERROR_MESSAGE } }
    : { status: 500, body: { error: DB_INTERNAL_ERROR_MESSAGE } };
}
