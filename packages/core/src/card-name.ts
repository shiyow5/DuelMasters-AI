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
 * そのため「落とす文字」は {@link CARD_NAME_STRIP_CHARS}、「長音に畳む文字」は
 * {@link CARD_NAME_DASH_CHARS} の1か所だけに書き、TS の正規表現と SQL の `translate` 引数は
 * どちらもここから作る。
 *
 * 処理順は TS / SQL とも **NFKC → 長音・ハイフン類を `ー` に畳む・記号を落とす → 小文字化**。
 * SQL では
 * `lower(translate(normalize(x, NFKC), CARD_NAME_TRANSLATE_FROM, CARD_NAME_TRANSLATE_TO))`。
 * (translate は from の i 文字目を to の i 文字目に置き換え、to より後ろの from の文字は消す。)
 * 畳む文字と落とす文字はどれも大文字/小文字を持たないので、小文字化との順序は結果に影響しない。
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

/** 長音・ハイフン類を畳む先 (長音符 U+30FC)。公式の規制カード名ではこれが大半を占める。 */
export const CARD_NAME_DASH_CANONICAL = "ー";

/**
 * 長音・ハイフン・ダッシュ・マイナス類 (#167 優先4)。どれも {@link CARD_NAME_DASH_CANONICAL} に畳む。
 *
 * カード名の `ー` は手入力やコピー元で `-` `－` `‐` `—` `―` `−` に化けやすい。落とさずに**1文字に畳む**
 * (落とすと「ゲート」と「ゲト」のような別の語まで同じキーになるため)。
 * 公式の規制カード 127 件 (2026-11-02 取得) で、畳んだあともキーの衝突が 0 件であることを確認した。
 *
 * - `-` U+002D, `‐` U+2010, `‑` U+2011, `‒` U+2012, `–` U+2013, `—` U+2014, `―` U+2015, `−` U+2212
 * - NFKC で上のどれかになる文字 (`－` U+FF0D, `﹣` U+FE63, `﹘` U+FE58) と、NFKC で `ー` になる `ｰ` U+FF70
 *   (SQL も NFKC 後に translate するので届かないが、TS の正規表現と同じ集合にしておく)
 */
export const CARD_NAME_DASH_CHARS: string =
  "-\u2010\u2011\u2012\u2013\u2014\u2015\u2212\uff0d\ufe63\ufe58\uff70";

/** SQL `translate` の第2引数。先頭が畳む文字、後ろが落とす文字。 */
export const CARD_NAME_TRANSLATE_FROM: string = CARD_NAME_DASH_CHARS + CARD_NAME_STRIP_CHARS;

/** SQL `translate` の第3引数。畳む文字の数だけ `ー` を並べる (それより後ろの from の文字は消える)。 */
export const CARD_NAME_TRANSLATE_TO: string = CARD_NAME_DASH_CANONICAL.repeat(
  [...CARD_NAME_DASH_CHARS].length,
);

/** 文字列の各文字に当たる文字クラスの正規表現 (コードポイントで組むのでエスケープ漏れが無い)。 */
function charClass(chars: string): RegExp {
  return new RegExp(
    `[${[...chars].map((c) => `\\u{${c.codePointAt(0)!.toString(16)}}`).join("")}]`,
    "gu",
  );
}

const STRIP_RE = charClass(CARD_NAME_STRIP_CHARS);
const DASH_RE = charClass(CARD_NAME_DASH_CHARS);

/**
 * カード名を照合用のキーにする。
 *
 * NFKC で全角/半角を畳み、{@link CARD_NAME_DASH_CHARS} を `ー` に畳み、{@link CARD_NAME_STRIP_CHARS} を
 * 落とし、小文字化する。SQL 側の
 * `lower(translate(normalize(x, NFKC), CARD_NAME_TRANSLATE_FROM, CARD_NAME_TRANSLATE_TO))` と同じ結果になる。
 */
export function cardNameKey(name: string): string {
  return name
    .normalize("NFKC")
    .replace(DASH_RE, CARD_NAME_DASH_CANONICAL)
    .replace(STRIP_RE, "")
    .toLowerCase();
}
