import type { Citation } from "./state.js";

/** searchRules が返すチャンク (出典生成に必要な最小形)。 */
interface RuleChunk {
  text: string;
  meta: Record<string, unknown>;
  /** 節の展開で補った兄弟条文か (#116)。true は出典から外す。 */
  expanded?: boolean;
}

/** 出典に載せる本文プレビューの最大文字数。 */
const CITATION_TEXT_LIMIT = 100;

/**
 * 検索チャンクを citations に変換する (#116)。**兄弟条文もここでは落とさない。**
 *
 * citations は2つの用途に使われる:
 * 1. **裏取り** (sanitizeCitations の #99)。本文の条番号が「retrieve した資料にあるか」を照合する。
 *    節の展開で補った兄弟条文 (expanded) も**実際に retrieve した資料**なので、ここから外すと、
 *    モデルが読んで正しく引用した兄弟条文の条番号が「捏造」と誤判定され本文から消える。
 * 2. **UI の出典**。ここでは兄弟条文はノイズなので見せたくない。
 *
 * そこで citations には全チャンクを載せつつ `expanded` 印を残し、**UI へ出す直前だけ**
 * `visibleCitations` で兄弟を落とす。裏取りは全件、表示は絞り込み、で両立させる。
 */
export function citationsFromChunks(chunks: RuleChunk[]): Citation[] {
  // text は meta 展開の**後**に置く。出典の text は必ず「切り詰めた本文プレビュー」であるべきで、
  // 万一 chunk_meta が text キーを持っても上書きされないようにする (防御。現行 meta には無い)。
  return chunks.map((ch) => ({
    ...ch.meta,
    text: ch.text.slice(0, CITATION_TEXT_LIMIT),
    expanded: ch.expanded === true,
  }));
}

/**
 * UI に見せる出典だけに絞る (#116)。**出力の直前で**呼ぶ。
 *
 * 節の展開で補った兄弟条文 (expanded) を落とし、内部用の `expanded` 印も取り除く
 * (利用者に見せる出典に内部フラグを残さない)。裏取り (sanitizeCitations) は絞り込み前の
 * 全 citations を使うので、これは表示のためだけの操作。
 */
export function visibleCitations(citations: Citation[]): Citation[] {
  return citations
    .filter((c) => c.expanded !== true)
    .map(({ expanded: _expanded, ...rest }) => rest);
}

/**
 * 回答本文の条番号を、実際に retrieve した資料に照らして機械的に検証する (#99)。
 *
 * ## なぜプロンプトだけでは足りないのか
 *
 * システムプロンプトで「参考資料に出てこない条番号を書いてはいけません」と明示しても、
 * agent は **【総合ルール 114.6】【総合ルール 114.6a】** をでっち上げた
 * (総合ルールの 114章「カードを引くこと」は **114.1〜114.4 しか無い**)。
 * eval で実測して確認している。#92 の裁定監査でも同じことが起きた (701.29a / 116.3a を捏造)。
 *
 * **LLM に「捏造するな」と言っても捏造する。機械的に潰すしかない。**
 *
 * ## なぜ「番号だけ」落とすのか
 *
 * 主張そのものは正しいことがある (上の例も「山札切れで敗北する」自体は正しい。
 * 正しい条文は 703.4b)。文ごと消すと回答が意味不明になるので、**番号だけ**落として
 * 【総合ルール】に留める。利用者が 114.6 を調べに行って存在しない、というのが最悪の結果。
 *
 * ## 書式を厳密に決め打ちしない
 *
 * 最初の実装は `【総合ルール 113.6】` という**厳密な形しか見ておらず**、自分で攻撃したら
 * 8通りの抜け道が見つかった:
 *
 *   【**総合ルール 114.6**】 (太字が内側) / 【総合ルール: 114.6】 (コロン) /
 *   【総合ルール 114.6と115.2】 (複数) / 【総合ルール １１４．６】 (全角) /
 *   ［総合ルール 114.6］ (全角括弧) / 条文 114.6 によれば (ラベル外) /
 *   【総合ルール 104.2ab】 (枝番2文字) / 【総合ルール 114.6.1】 (3階層)
 *
 * **「見たことのある書式だけ守る防御」は防御ではない。** 囲みの中身は寛容に読み、
 * 条番号らしきトークンを**すべて**検証する。
 *
 * ## 塞がない残余リスク (意図的)
 *
 * **キーワードを伴わない裸の番号** (「114.6 により敗北します」) は落とさない。
 * `\d+\.\d+` を無条件に落とすと「勝率は 52.3%」「コストは 3.5」といった**正当な数字まで
 * 壊れる**。過剰除去のほうが害が大きい。
 *
 * 前提: プロンプトは 【総合ルール N】 の形を必須にしており、eval でも agent はこの形で書く。
 * また、キーワードの無い裸の数字は読み手にも「条番号」として読まれにくい。
 */

/**
 * 見えない文字。挿入するだけで正規表現をすり抜けられる (`114\u200b.6`)。
 * ルール回答に混ざる正当な理由が無いので、検査の前に落とす。
 */
const INVISIBLE = /[\u200b-\u200d\ufeff]/g;

/**
 * 囲み (半角/全角) の中に「総合ルール」を含むラベル。中身は寛容に読む。
 * キーワード内の空白も許す (`総合 ルール` で回避されないように)。
 */
const RULE_LABEL = /[【［]([^】］]*総合\s*ルール[^】］]*)[】］]/g;

/**
 * 条番号らしきトークン。**節は3桁**である (総合ルールは 000〜900番台)。
 *
 * 3桁で始まらない数字は条番号ではないので**触らない**。これが無いと
 * 「総合ルール 1.50版」(本プロジェクトのルールブック版数!) を条番号と誤認して**本文を壊す**。
 *
 * さらに、3桁のかたまりが**より長い数字の一部でないこと**も要求する。前後の数字を見ないと
 * 「2020年」の先頭3桁 "202" を条番号と読んでしまい、同じラベルにある**正当な引用まで
 * 巻き添えで消える**。
 *
 * 小数点は必須にしない。`【総合ルール 500】` のような節への言及が素通りし、
 * `【総合ルール 999】` まで通ってしまう (eval で agent が実際に 500 を引いた)。
 */
const ARTICLE_TOKEN =
  /(?<![0-9０-９])[0-9０-９]{3}(?![0-9０-９])(?:[.．][0-9０-９.．]*[a-zａ-ｚA-ZＡ-Ｚ]*)?/g;

/** ラベル外の条番号。**キーワードは数字の前に来る**形 (「条文 114.6」「ルール114.6」)。 */
const BARE_BEFORE =
  /(総合\s*ルール|ルール|条文)\s*(?:第)?\s*[:：]?\s*((?<![0-9０-９])[0-9０-９]{3}(?![0-9０-９])(?:[.．][0-9０-９.．]*[a-zａ-ｚA-ZＡ-Ｚ]*)?)/g;

/**
 * ラベル外の条番号。**キーワードが数字の後ろに来る**形 (「114.6条によれば」)。
 * 日本語ではこちらが自然だが、最初の実装は前方キーワードしか見ておらず**素通りしていた**。
 */
const BARE_AFTER =
  /((?<![0-9０-９])[0-9０-９]{3}(?![0-9０-９])(?:[.．][0-9０-９.．]*[a-zａ-ｚA-ZＡ-Ｚ]*)?)\s*条/g;

/**
 * 正規の条番号の形。`113.6` / 枝番1文字の `501.2a` / 節だけの `113` を認める。
 *
 * `104.2ab` (枝番2文字) や `114.6.1` (3階層) は総合ルールに存在しない形なので、
 * ここで弾いて「裏取りできない」= 落とす対象にする。**知らない形は通さない。**
 */
const CANONICAL_ARTICLE = /^(\d{3})(?:\.(\d+)([a-z])?)?$/;

/** 全角の数字・記号を半角へ寄せて比較可能にする。 */
function normalizeArticle(token: string): string {
  return token.normalize("NFKC").toLowerCase();
}

/** 見えない文字を落とす (検査の前処理)。 */
function stripInvisible(text: string): string {
  return text.replace(INVISIBLE, "");
}

/**
 * 本文が「総合ルールの条文として引いている」条番号をすべて取り出す。
 *
 * **eval の指標もこれを使う。** 抽出を2箇所に書いたらズレて、サニタイザが認識する
 * `【総合ルール113.6と115.2】` を指標が「引用なし」と誤判定した (= ゲートが盲目になった)。
 */
export function citedArticles(text: string): string[] {
  const source = stripInvisible(text);
  const found = new Set<string>();
  for (const m of source.matchAll(RULE_LABEL)) {
    for (const t of m[1].match(ARTICLE_TOKEN) ?? []) found.add(normalizeArticle(t));
  }
  for (const m of source.matchAll(BARE_BEFORE)) found.add(normalizeArticle(m[2]));
  for (const m of source.matchAll(BARE_AFTER)) found.add(normalizeArticle(m[1]));
  return [...found];
}

export interface SanitizeResult {
  /** 裏取りできない条番号を落とした本文。 */
  text: string;
  /** 落とした条番号 (重複は畳む)。捏造の発生を計測・監視するために返す。 */
  stripped: string[];
}

export function sanitizeCitations(text: string, citations: Citation[]): SanitizeResult {
  // 見えない文字を先に落とす。残すと `114\u200b.6` で検査をすり抜けられる。
  const source = stripInvisible(text);

  const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));
  const retrieved = new Set(citations.map((c) => str(c.article)).filter(Boolean));
  // 節 (500) への言及も検証する。section メタが無い経路もあるので、条番号の親からも復元する。
  const sections = new Set(
    [...citations.map((c) => str(c.section)), ...[...retrieved].map((a) => a.split(".")[0])].filter(
      Boolean,
    ),
  );

  /**
   * 枝番 (104.2a) は親チャンク (104.2) の本文に埋まっており、citations には親の条番号しか
   * 載らない。枝番を捏造扱いすると**正しい引用まで落ちる** (#92 で実際にこの誤判定をやった)。
   */
  function isGrounded(article: string): boolean {
    const m = CANONICAL_ARTICLE.exec(article);
    if (!m) return false; // 知らない形 (3階層・枝番2文字) は通さない

    // 節だけ (113) → retrieve した条文の節に含まれるか
    if (m[2] === undefined) return sections.has(m[1]);

    // 条番号 (113.6) / 枝番 (501.2a) → そのもの、または親条文が retrieve されているか
    return retrieved.has(article) || retrieved.has(`${m[1]}.${m[2]}`);
  }

  const stripped = new Set<string>();

  // 1) 【…総合ルール…】ラベルの中の条番号を全部見る。
  let out = source.replace(RULE_LABEL, (whole, inner: string) => {
    const tokens = inner.match(ARTICLE_TOKEN);
    if (!tokens) return whole; // 【総合ルール】 だけ → そのまま

    const kept: string[] = [];
    let dropped = false;
    for (const t of tokens) {
      const a = normalizeArticle(t);
      if (isGrounded(a)) kept.push(a);
      else {
        stripped.add(a);
        dropped = true;
      }
    }
    if (!dropped) return whole; // すべて裏取り済み → 原文のまま (太字などの装飾も保つ)
    return kept.length > 0 ? `【総合ルール ${kept.join("・")}】` : "【総合ルール】";
  });

  // 2) ラベル外の条番号。キーワードは前 (「条文 114.6」) にも後ろ (「114.6条」) にも来る。
  out = out.replace(BARE_BEFORE, (whole, keyword: string, token: string) => {
    const a = normalizeArticle(token);
    if (isGrounded(a)) return whole;
    stripped.add(a);
    return keyword; // 番号だけ落とす (主張は残す)
  });
  out = out.replace(BARE_AFTER, (whole, token: string) => {
    const a = normalizeArticle(token);
    if (isGrounded(a)) return whole;
    stripped.add(a);
    return "条";
  });

  return { text: out, stripped: [...stripped] };
}
