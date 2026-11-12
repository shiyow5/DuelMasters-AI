/**
 * 信頼境界の区切り (#254 M-3)。RAG の参考資料とツール結果を、モデルへ渡す前にこの区切りで囲む。
 *
 * 資料の中身は外部サイト由来で、攻撃者が書ける。資料の中に区切り文字列を書かれると
 * 「ここでデータ領域が終わった」と偽装できるため、**囲む前に資料側から区切りを除去する**。
 */
export const DATA_START = "<<<資料 開始>>>";
export const DATA_END = "<<<資料 終了>>>";

/**
 * 区切りの偽装を拾う正規表現。空白・全角山括弧・「開始/終了」の言い換えまで広めに落とす。
 * 通常の資料にこの形は現れない (総合ルール・裁定に `<<<` は無い)。
 */
const DELIMITER_LIKE = /[<＜]{2,}\s*資料\s*[^<>＜＞\n]{0,6}[>＞]{2,}/g;

/** 資料文字列から区切り (偽装を含む) を除去する。 */
export function stripDelimiters(text: string): string {
  return text.replaceAll(DATA_START, "").replaceAll(DATA_END, "").replace(DELIMITER_LIKE, "");
}

/** 外部由来のテキストをデータ領域として囲む。 */
export function wrapUntrusted(text: string): string {
  return `${DATA_START}\n${stripDelimiters(text)}\n${DATA_END}`;
}
