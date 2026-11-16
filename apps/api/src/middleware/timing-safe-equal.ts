/**
 * 内部キーの定数時間比較 (#255 L-1)。
 *
 * 文字列の === 比較は早期リターンするため、タイミングアタックでキーの先頭から
 * 1文字ずつ推測できる。Workers 環境ではネットワーク越しの計測は困難だが、
 * 正しい実装として統一する。
 *
 * Cloudflare Workers: `crypto.subtle.timingSafeEqual` (Web Crypto API)
 * Node.js: `node:crypto.timingSafeEqual`
 * 両方の環境で動くように polyfill する。
 */

/** ArrayBuffer (Uint8Array のビュー) 間の定数時間比較。 */
function timingEqual(ab: ArrayBuffer, bb: ArrayBuffer): boolean {
  if (ab.byteLength !== bb.byteLength) return false;

  // Cloudflare Workers (Web Crypto API)
  if (typeof crypto.subtle?.timingSafeEqual === "function") {
    return crypto.subtle.timingSafeEqual(ab, bb);
  }

  // Node.js (node:crypto) — 動的 import
  const { timingSafeEqual } = require("node:crypto");
  return timingSafeEqual(new Uint8Array(ab), new Uint8Array(bb));
}

/** 2つの文字列を定数時間で比較する。 */
export function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);

  if (bufA.length !== bufB.length) return false;

  return timingEqual(
    bufA.buffer as ArrayBuffer,
    bufB.buffer as ArrayBuffer
  );
}
