/** 検索語の最大数。ILIKE を語数ぶん並べるため上限を設ける。 */
const MAX_TERMS = 5;

/**
 * 内容語の切り出しパターン。日本語は単語間に空白が無いので、文字種の切れ目で切る。
 *
 * 1. 条番号 (500.6 / 113.6a) — 条文本文に番号がそのまま入っているので直接引ける最強の検索語
 * 2. 中黒つきの複合語 (S・トリガー / G・ストライク / T・ブレイカー) — 1語として保つ
 * 3. カタカナ列 (シールド / クリーチャー)
 * 4. 漢字列 (順番 / 処理)
 * 5. 英字列 (EX / cip)
 *
 * ひらがな (助詞・語尾) と裸の数字はどのパターンにも当たらないため自然に落ちる。
 */
const TERM_PATTERN =
  /\d{3}\.\d+[a-z]?|[A-Za-z0-9ァ-ヶー]+(?:・[A-Za-z0-9ァ-ヶー]+)+|[ァ-ヶー]+|[一-鿿々]+|[A-Za-z]+/g;

/** 条番号は短くても識別力が高いので、長さフィルタの対象外にする。 */
const ARTICLE_PATTERN = /^\d{3}\.\d+[a-z]?$/;

/**
 * 日本語クエリから ILIKE 検索用の語を取り出す。
 *
 * 空白区切り (`split(/\s/)`) では日本語の文が丸ごと1語になり、`ILIKE '%文全体%'` が
 * 必ず0件になる。実際に「1ターンの流れを順番に教えてください」でキーワード検索が
 * 全滅し、ハイブリッド検索が実質ベクトルのみで動いていた。
 *
 * 1文字の語は識別力が無く (「時」「使」など語尾由来のノイズ)、ILIKE が広く当たりすぎるので捨てる。
 * 残った語は条番号を最優先し、あとは長い順に採る — 長い語ほど具体的で誤マッチが少ない。
 */
export function extractTerms(query: string): string[] {
  const raw = query.match(TERM_PATTERN) ?? [];
  return raw
    .filter((t) => ARTICLE_PATTERN.test(t) || t.length >= 2)
    .map((t, i) => ({ t, i }))
    .sort((a, b) => {
      const aArticle = ARTICLE_PATTERN.test(a.t) ? 1 : 0;
      const bArticle = ARTICLE_PATTERN.test(b.t) ? 1 : 0;
      return bArticle - aArticle || b.t.length - a.t.length || a.i - b.i;
    })
    .slice(0, MAX_TERMS)
    .map(({ t }) => t);
}
