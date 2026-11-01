/**
 * カード名の照合キー (#111 / B-02 / #167)。
 *
 * 次の箇所が**同じ文字集合**で名前を畳む必要がある。ズレると「TS では一致するのに
 * SQL では引けない」(またはその逆) が起き、殿堂チェックや検索をすり抜ける。
 *
 * - `normalizeCardName` (packages/agent/src/card-search.ts) — 検索語
 * - `regulationNameKey` (packages/deck-engine/src/card-name.ts) — 殿堂チェック
 * - `search_cards` の SQL (packages/agent/src/tools.ts) — DB 側の name
 *
 * そのため「落とす文字」は {@link CARD_NAME_STRIP_CHARS} の1か所だけに書き、
 * TS の正規表現と SQL の `translate` 引数はどちらもここから作る。
 *
 * 処理順は TS / SQL とも **NFKC → 記号を落とす → 小文字化**。
 * SQL では `lower(translate(normalize(x, NFKC), CARD_NAME_STRIP_CHARS, ''))`。
 * 落とす文字はどれも大文字/小文字を持たないので、小文字化との順序は結果に影響しない。
 */

/** 中黒 (全角・半角)。#111 で検索が全滅した原因。 */
const NAKAGURO = "・･";

/** 囲み記号。≪≫«» は従来 TS だけが落としていた (#167 で SQL にも揃えた)。 */
const BRACKETS = "《》≪≫«»『』【】「」";

/**
 * 引用符 (#167 優先1)。`“轟轟轟”ブランド` が殿堂チェックをすり抜けていた。
 * 全角の ＂ ＇ は NFKC で " ' になるので、NFKC 後の ASCII 版も含める。
 */
const QUOTES = "“”‘’\"'";

/**
 * 空白。従来 TS は `\s` (JS の空白全般) を落としていたが、SQL は半角/全角スペースだけだった。
 * `\s` が当たる文字をすべて列挙して SQL にも渡す (一致はユニットテストで全コードポイント検査)。
 */
const WHITESPACE = "\t\n\v\f\r              " + "    　﻿";

/**
 * カード名の照合で**落とす文字の唯一の定義**。
 * SQL の `translate(x, CARD_NAME_STRIP_CHARS, '')` にはこの文字列をそのままバインドする。
 */
export const CARD_NAME_STRIP_CHARS: string = NAKAGURO + BRACKETS + QUOTES + WHITESPACE;

/** {@link CARD_NAME_STRIP_CHARS} の各文字に当たる正規表現 (コードポイントで組むのでエスケープ漏れが無い)。 */
const STRIP_RE = new RegExp(
  `[${[...CARD_NAME_STRIP_CHARS].map((c) => `\\u{${c.codePointAt(0)!.toString(16)}}`).join("")}]`,
  "gu",
);

/**
 * カード名を照合用のキーにする。
 *
 * NFKC で全角/半角を畳み、{@link CARD_NAME_STRIP_CHARS} を落とし、小文字化する。
 * SQL 側の `lower(translate(normalize(x, NFKC), CARD_NAME_STRIP_CHARS, ''))` と同じ結果になる。
 */
export function cardNameKey(name: string): string {
  return name.normalize("NFKC").replace(STRIP_RE, "").toLowerCase();
}
