/**
 * 取込み時のアーキタイプ名・大会名の検証 (#254 M-3 ②)。
 *
 * アーキタイプ名・大会名は外部サイト由来 (supersolenoid.jp) または LLM 抽出 (ingest/url) で、
 * DB に入った後は**チャット回答の材料 (ツール結果)** と UI の表示に出る。URL・改行・タグ・長文を
 * 通すと、そこにプロンプトインジェクションやリンク誘導を仕込める。取り込む前に弾く。
 *
 * 値と許可文字は**本番 DB の実測**から決めた (2026-11-12, 読み取り専用の集計):
 *
 * | 列 | 行数 | 重複除去 | p50 | p99 | 最大 |
 * |---|---|---|---|---|---|
 * | tournament_results.deck_archetype | 3912 | 562 | 8 | 24 | 42 字 (126 byte) |
 * | archetype_weekly_stats.deck_archetype | 1353 | 431 | 7 | 21 | 27 字 |
 * | tournament_results.event_name | 3912 | 576 | 14 | 33 | 39 字 |
 *
 * - アーキタイプ名の上限は 60 字 (実測最大 42 の約 1.4 倍)。当初案の 40 字では既存の 42 字の行を落とす。
 * - **NFKC で判定してはいけない。** 実データに全角の `＜あきない遊びだぜ！＞` (11 件) があり、NFKC は
 *   これを ASCII の `<>` にする。`<>` の禁止を NFKC 後に掛けると既存データを落とす。文字種は**原文**で見る。
 *   NFKC は「URL の偽装 (ｈｔｔｐ：／／)」を見つける用途だけに使う。
 * - 実データの記号: `＆ . ・ … 、 ！ - ＜ ＞ ∞ ＝ 「 」 × , “ ” ! ? / & Ⅻ`。これを許可文字に含める。
 * - URL / http / 改行 / `<>{}[]` を含む行は 0 件 (実測)。禁止しても既存データは落ちない。
 */

/** アーキタイプ名の最大文字数 (code point)。実測最大 42 に余裕を持たせた値。 */
export const ARCHETYPE_NAME_MAX_LENGTH = 60;
/** 大会名の最大文字数 (code point)。実測最大 39。 */
export const EVENT_NAME_MAX_LENGTH = 100;

/**
 * 許可文字: 文字 (\p{L}) ・数字 (\p{N}、Ⅻ 等を含む) ・結合文字 (濁点) ・空白と、実データに現れる記号。
 * `<>{}[]` ・改行・制御文字・バッククォート・`\` ・`|` ・`$` ・`;` ・`%` は含まない。
 */
const ARCHETYPE_ALLOWED =
  /^[\p{L}\p{N}\p{M} 　・ー－\-/&＆'’"“”()（）!！?？.．,，、。…＝=＜＞「」『』∞×~～:：+＋☆★♪]+$/u;
/** 大会名は店舗名・日付表記・タグが入るので `@ ＠ 【 】` を足す。 */
const EVENT_ALLOWED =
  /^[\p{L}\p{N}\p{M} 　・ー－\-/&＆'’"“”()（）!！?？.．,，、。…＝=＜＞「」『』∞×~～:：+＋☆★♪@＠【】]+$/u;

/** URL らしさ。NFKC 後に見るので、全角の `ｈｔｔｐ：／／` や `ｗｗｗ．` も拾う。 */
const URL_LIKE = /https?|:\/\/|www\./i;

function length(s: string): number {
  return [...s].length;
}

function validate(raw: unknown, max: number, allowed: RegExp): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (s === "" || length(s) > max) return null;
  if (!allowed.test(s)) return null;
  if (URL_LIKE.test(s.normalize("NFKC"))) return null;
  return s;
}

/** アーキタイプ名を検証し、前後の空白を除いた値を返す。不合格なら null。 */
export function normalizeArchetypeName(raw: unknown): string | null {
  return validate(raw, ARCHETYPE_NAME_MAX_LENGTH, ARCHETYPE_ALLOWED);
}

/** 大会名を検証し、前後の空白を除いた値を返す。不合格なら null。 */
export function normalizeEventName(raw: unknown): string | null {
  return validate(raw, EVENT_NAME_MAX_LENGTH, EVENT_ALLOWED);
}

export function isValidArchetypeName(raw: unknown): boolean {
  return normalizeArchetypeName(raw) !== null;
}

export function isValidEventName(raw: unknown): boolean {
  return normalizeEventName(raw) !== null;
}

/**
 * `deck_archetype` を持つ行から、不合格の行を除く。**取込み全体は失敗させない** (件数だけ返す)。
 * 返す行の `deck_archetype` は trim 済み。名前そのものはログに出さない (攻撃者が書ける文字列のため)。
 */
export function partitionValidArchetypes<T extends { deck_archetype: string }>(
  rows: readonly T[],
): { valid: T[]; rejected: number } {
  const valid: T[] = [];
  for (const r of rows) {
    const name = normalizeArchetypeName(r.deck_archetype);
    if (name !== null) valid.push({ ...r, deck_archetype: name });
  }
  return { valid, rejected: rows.length - valid.length };
}
