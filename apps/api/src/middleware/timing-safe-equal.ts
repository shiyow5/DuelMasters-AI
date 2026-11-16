/**
 * 内部キーの比較 (#255 L-1 / #273 R1)。
 *
 * 両入力を SHA-256 で固定長 (32 バイト) にしてから、ランタイム標準の
 * `crypto.timingSafeEqual` で比較する (Workers は `nodejs_compat`、Node はそのまま動く)。
 * 確認できる保証は次のとおり:
 *  - 比較が接頭辞の一致位置で早期終了しない (固定長ダイジェスト同士の比較)
 *  - 入力長の違いが比較ループの回数に影響しない
 * 入力長そのもの (ハッシュ計算量) は隠さない。内部キーは固定長 ASCII (hex / base64url 等) を
 * 前提とし、長さはタイミング上の秘匿対象にしない。
 * 孤立サロゲートを含む文字列は UTF-8 変換で U+FFFD に置換され別文字列と衝突するため、
 * 常に false を返す。
 */
import { createHash, timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";

/** 比較対象の最大長 (文字数)。これを超える入力は比較せず false。 */
const MAX_INPUT_LENGTH = 1024;

/** 孤立サロゲート (対になっていない上位/下位サロゲート)。 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** 2つの文字列を比較する。undefined/null/空文字/長すぎる/不正な Unicode は false。 */
export function timingSafeEqual(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length === 0 || b.length === 0) return false;
  if (a.length > MAX_INPUT_LENGTH || b.length > MAX_INPUT_LENGTH) return false;
  if (LONE_SURROGATE.test(a) || LONE_SURROGATE.test(b)) return false;
  return nodeTimingSafeEqual(digest(a), digest(b));
}
