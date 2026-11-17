/**
 * ログ用の例外種別名 (#311)。
 *
 * 捕捉した例外をそのままログに出すと、message・stack・cause から接続先や入力値が漏れうる。
 * ログには種別名だけを出す。DB に依存しないアプリ (apps/bot など) でも使えるよう core に置く。
 * DB 例外の要約 (SQLSTATE つき) は `@dm-ai/db` の `toSafeErrorLog` を使う。
 */

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
  let name: unknown;
  try {
    name = (err as Record<string, unknown>).name;
  } catch {
    // getter や Proxy が throw しても握りつぶす
    name = undefined;
  }
  return typeof name === "string" && ERROR_NAME_PATTERN.test(name) ? name : "UnknownError";
}
