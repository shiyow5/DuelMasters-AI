/**
 * 内部キーの定数時間比較 (#255 L-1)。
 *
 * 文字列の === 比較は早期リターンするため、タイミングアタックでキーの先頭から
 * 1文字ずつ推測できる。Workers / Node 双方で動くよう、プラットフォーム API に
 * 依存せず XOR を累積する実装にする。長さが異なる場合も最長側の長さ分だけ
 * ループし、長さ差は結果に畳み込んで最後に false を返す。
 */

/** 2つの文字列を定数時間で比較する。undefined/null は false。 */
export function timingSafeEqual(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;

  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  const len = Math.max(bufA.length, bufB.length);

  let diff = bufA.length ^ bufB.length;
  for (let i = 0; i < len; i++) {
    diff |= (bufA[i] ?? 0) ^ (bufB[i] ?? 0);
  }
  return diff === 0;
}
