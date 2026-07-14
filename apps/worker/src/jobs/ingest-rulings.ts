/**
 * 公式「よくある質問(裁定)」を RAG (rule_chunks) に取り込むジョブ。
 *
 * ## 一次情報源は**2つある** (#123)
 *
 * | 集合 | 取得方法 | 件数 |
 * | --- | --- | --- |
 * | **現行** `/rule/qa/` | HTML ページング (REST に出ていない) | 約 3,955 |
 * | **過去** `qa_old` | WP REST API (投稿タイプ名は「**過去の**よくある質問」) | 約 3,246 |
 *
 * **長らく `qa_old` しか取り込んでおらず、現行の裁定を1件も持っていなかった。**
 * 公式裁定の半分以上が RAG から欠けていた。2つは排他 (同じ ID は片方にしか無く、
 * もう片方は 301 でリダイレクトする)。
 *
 * **必ず1つのジョブで両方を扱うこと。** 末尾の prune が
 * `doc_type='ruling' AND qa_id NOT IN (keep)` で掃除するため、片方だけを取り込むジョブを
 * 別に作ると、もう片方を**全部消す**。
 *
 * 回答はどちらも各 HTML ページの `.question` / `.answer` から取る (構造は同じ)。
 * doc_type='ruling' で qa_id 単位に冪等 upsert。
 *
 * 公式サイトには改定前の裁定がそのまま残っており、同じ質問で結論が逆のペアがある。
 * 古い方を取り込むと RAG が現行ルールに反する答えを引くため、質問文で名寄せして
 * **現行 > 過去**、同じ集合内なら qa_id の新しい方だけを採る (dedupeRulingList)。
 */
import { pathToFileURL } from "node:url";
import * as cheerio from "cheerio";
import { getSql, closeDb } from "@dm-ai/db";
import { embed } from "@dm-ai/core";
import { sleep, fetchWithRetry } from "../lib.js";
import { OFFICIAL_SITE_BASE_URL } from "../constants.js";
import { applyDeprecations } from "./deprecate-rulings.js";

/** 過去の裁定 (アーカイブ)。WP REST API に出ている唯一の投稿タイプ。 */
const QA_API = `${OFFICIAL_SITE_BASE_URL}/wp-json/wp/v2/qa_old`;
/** 現行の裁定。**REST に出ていない** (`wp/v2/qa` は 404) ので HTML をページングする。 */
const QA_LIST_URL = `${OFFICIAL_SITE_BASE_URL}/rule/qa/`;
const LIST_PER_PAGE = 100;
const EMBED_FLUSH = 20;
const FETCH_DELAY_MS = 150;

/** 裁定がどちらの集合から来たか。名寄せで**現行を優先**するために要る。 */
export type RulingSource = "current" | "archived";

export interface RulingItem {
  id: number;
  question: string;
  link: string;
  source: RulingSource;
  /**
   * 公開日 (YYYY-MM-DD)。**現行の一覧ページにしか無い。**
   * qa_old の日付は全件 1990-01-01 のプレースホルダで使い物にならなかった (#92)。
   */
  date?: string;
}

function today(): string {
  return new Date().toISOString().split("T")[0];
}

/** HTML 断片からテキストを取り出す (エンティティ復号込み)。 */
function htmlToText(html: string): string {
  return cheerio.load(`<div>${html}</div>`)("div").text().replace(/\s+/g, " ").trim();
}

/** 先頭の Q/A ラベル (半角/全角) を除去する。ページは .question/.answer に "Q"/"A" 接頭を含む。 */
function stripLabel(text: string, label: "Q" | "A"): string {
  const full = label === "Q" ? "Ｑ" : "Ａ";
  return text.replace(new RegExp(`^[${label}${full}][.．:：]?\\s*`), "").trim();
}

/** 裁定ページ HTML から質問・回答を抽出する (純粋関数・テスト対象)。 */
export function parseRulingHtml(html: string): { question: string; answer: string } {
  const $ = cheerio.load(html);
  const question = stripLabel($(".question").first().text().replace(/\s+/g, " ").trim(), "Q");
  const answer = stripLabel($(".answer").first().text().replace(/\s+/g, " ").trim(), "A");
  return { question, answer };
}

/**
 * 「2026.7.9」→「2026-07-09」。現行の一覧ページの `p.day01` の書式。
 * 読めない書式なら undefined (日付を捏造しない)。
 */
export function parseJpDate(text: string): string | undefined {
  const m = /(\d{4})[./-](\d{1,2})[./-](\d{1,2})/.exec(text.trim());
  if (!m) return undefined;
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

/**
 * 現行の裁定一覧ページ (`/rule/qa/page/N/`) から 1ページぶんを取り出す (純粋関数・テスト対象)。
 *
 * 構造:
 *   <ul class="newsList03">
 *     <li>
 *       <p class="tit01"><a href=".../rule/qa/49017/">質問文</a></p>
 *       <p class="day01">2026.7.9</p>
 */
export function parseRulingListPage(html: string): RulingItem[] {
  const $ = cheerio.load(html);
  const items: RulingItem[] = [];
  $("ul.newsList03 > li").each((_, el) => {
    const a = $(el).find("p.tit01 a").first();
    const link = a.attr("href") ?? "";
    const m = /\/rule\/qa\/(\d+)\//.exec(link);
    if (!m) return;
    items.push({
      id: Number(m[1]),
      question: a.text().replace(/\s+/g, " ").trim(),
      link,
      source: "current",
      date: parseJpDate($(el).find("p.day01").first().text()),
    });
  });
  return items;
}

/**
 * 現行の裁定一覧を集める (HTML ページング)。
 *
 * REST に出ていないので HTML を舐めるしかない。最終ページを超えると 404 = 正常終端。
 * それ以外のエラーは**サイレントな部分取込を避けるため** job を失敗させる
 * (部分取込のまま prune が走ると、取れなかったぶんが本番から消える)。
 */
export async function fetchCurrentRulingList(limit?: number): Promise<RulingItem[]> {
  const out: RulingItem[] = [];
  for (let page = 1; ; page++) {
    const url = page === 1 ? QA_LIST_URL : `${QA_LIST_URL}page/${page}/`;
    let html: string;
    try {
      html = await fetchWithRetry(url);
    } catch (err) {
      if (err instanceof Error && /HTTP 404\b/.test(err.message)) break;
      throw err;
    }
    const items = parseRulingListPage(html);
    if (items.length === 0) break;
    for (const item of items) {
      out.push(item);
      if (limit && out.length >= limit) return out.slice(0, limit);
    }
    await sleep(FETCH_DELAY_MS);
  }
  return out;
}

/** qa_old API をページングして**過去の**裁定一覧 (id/質問/リンク) を集める。 */
export async function fetchRulingList(limit?: number): Promise<RulingItem[]> {
  const out: RulingItem[] = [];
  for (let page = 1; ; page++) {
    const url = `${QA_API}?per_page=${LIST_PER_PAGE}&page=${page}&_fields=id,title,link`;
    let arr: Array<{ id: number; title: { rendered: string }; link: string }>;
    try {
      arr = JSON.parse(await fetchWithRetry(url));
    } catch (err) {
      // WP は総ページ超過時に 400 (rest_post_invalid_page_number) を返す=正常終端。
      // それ以外 (500/429/ネットワーク/JSON 破損) はサイレントな部分取込を避けるため job を失敗させる。
      if (err instanceof Error && /HTTP 400\b/.test(err.message)) break;
      throw err;
    }
    if (!Array.isArray(arr) || arr.length === 0) break;
    for (const p of arr) {
      out.push({
        id: p.id,
        question: htmlToText(p.title?.rendered ?? ""),
        link: p.link,
        source: "archived",
      });
      if (limit && out.length >= limit) return out.slice(0, limit);
    }
    if (arr.length < LIST_PER_PAGE) break;
  }
  return out;
}

/** 中身が空のカード名括弧 (《》)。公式ページのカード名リンクが壊れている印。 */
const EMPTY_CARD_BRACKET = /[《≪«『]\s*[》≫»』]/;

/**
 * 裁定ページの質問文と qa_old API の title から、情報が欠けていない方を選ぶ。
 *
 * 公式の裁定ページはカード名リンクを
 *   `<a href='/card/detail/?id='>《》</a>`
 * と、**id もカード名も空のまま**出力していることがある (公式側の不具合)。ページ側を
 * 無条件に優先すると、カード名の落ちた質問文が RAG に入り、そのカード名では二度と引けない。
 * API の title にはカード名が残っているので、そちらへ倒す。
 */
export function pickQuestion(pageQuestion: string, apiTitle: string): string {
  if (!pageQuestion) return apiTitle;
  if (EMPTY_CARD_BRACKET.test(pageQuestion) && apiTitle && !EMPTY_CARD_BRACKET.test(apiTitle)) {
    return apiTitle;
  }
  return pageQuestion;
}

/**
 * 質問文の同一性判定用に正規化する。
 * 「【基本ルール】」等の接頭ラベルは改定時に付くことがあるので落とし、空白差・半角カナ差も潰す。
 *
 * 落とすのは**先頭のラベルだけ**。質問文の途中にある【マナ武装】のような括弧まで消すと、
 * 別々の裁定が同じキーに潰れてしまい、全件取込の prune で正当な裁定が DELETE される。
 */
function normalizeQuestion(q: string): string {
  return q
    .normalize("NFKC")
    .replace(/^\s*【[^】]*】/, "")
    .replace(/\s+/g, "");
}

/**
 * 同じ質問の裁定が2つあるとき、どちらを採るか。
 *
 * **1. 現行 (`/rule/qa/`) を過去 (`qa_old`) より優先する。**
 * qa_old は投稿タイプ名からして「**過去の**よくある質問」。ID の大小では決められない
 * (現行側にも 31971 のような小さい ID があり、過去側の 35220 より小さい)。
 * **どちらの集合にいるかが、新旧の唯一の手がかり。**
 *
 * 2. 同じ集合の中なら qa_id が大きい (＝後から作られた) 方。
 */
function isNewerRuling(a: RulingItem, b: RulingItem): boolean {
  if (a.source !== b.source) return a.source === "current";
  return a.id > b.id;
}

/**
 * 同じ質問の裁定が複数あれば、新しい方だけ残す。並び順は元のまま。
 * 公式サイトに残る改定前の裁定が現行ルールと矛盾するため、新しい方へ寄せる。
 */
export function dedupeRulingList(items: RulingItem[]): RulingItem[] {
  const best = new Map<string, RulingItem>();
  for (const item of items) {
    const key = normalizeQuestion(item.question);
    const current = best.get(key);
    if (current === undefined || isNewerRuling(item, current)) best.set(key, item);
  }
  // WP の投稿 ID は投稿タイプを跨いで一意なので、id で同定してよい。
  const keep = new Set([...best.values()].map((i) => i.id));
  return items.filter((item) => keep.has(item.id));
}

export async function runIngestRulings(opts: { limit?: number; version?: string } = {}): Promise<{
  inserted: number;
  skipped: number;
  pruned: number;
  total: number;
  deprecated: number;
}> {
  const sql = getSql();
  const version = opts.version ?? today();

  // **現行と過去の両方を取る** (#123)。片方だけだと、末尾の prune がもう片方を全部消す。
  const current = await fetchCurrentRulingList(opts.limit);
  const archived = await fetchRulingList(opts.limit);
  const fetched = [...current, ...archived];
  const list = dedupeRulingList(fetched);
  const duplicates = fetched.length - list.length;
  console.log(
    `=== 裁定取り込み開始: 現行 ${current.length}件 + 過去 ${archived.length}件 → 対象 ${list.length}件 ` +
      `(重複質問 ${duplicates}件を新しい裁定へ寄せた) ===`,
  );

  let inserted = 0;
  let skipped = 0;
  let buffer: Array<{
    qaId: number;
    url: string;
    text: string;
    source: RulingSource;
    date?: string;
  }> = [];

  const flush = async () => {
    if (buffer.length === 0) return;
    const embeddings = await embed(buffer.map((b) => b.text));
    await sql.begin(async (tx) => {
      const txSql = tx as unknown as typeof sql;
      for (let i = 0; i < buffer.length; i++) {
        const b = buffer[i];
        const vec = `[${(embeddings[i] ?? []).join(",")}]`;
        await txSql`DELETE FROM rule_chunks WHERE doc_type = 'ruling' AND chunk_meta->>'qa_id' = ${String(b.qaId)}`;
        await txSql`
          INSERT INTO rule_chunks (doc_type, version, chunk_text, chunk_meta, embedding)
          VALUES ('ruling', ${version}, ${b.text},
                  ${sql.json({ url: b.url, qa_id: b.qaId, source: b.source, ...(b.date ? { date: b.date } : {}) })},
                  ${vec}::vector)
        `;
      }
    });
    inserted += buffer.length;
    console.log(`  ...${inserted}件挿入済み`);
    buffer = [];
  };

  for (const item of list) {
    try {
      const html = await fetchWithRetry(item.link);
      const { question, answer } = parseRulingHtml(html);
      const q = pickQuestion(question, item.question);
      if (!answer) {
        skipped++;
        continue;
      }
      buffer.push({
        qaId: item.id,
        url: item.link,
        text: `Q: ${q}\nA: ${answer}`,
        source: item.source,
        date: item.date,
      });
      if (buffer.length >= EMBED_FLUSH) await flush();
      await sleep(FETCH_DELAY_MS);
    } catch (err) {
      console.warn(`スキップ ${item.link}: ${(err as Error).message}`);
      skipped++;
    }
  }
  await flush();

  // 全件取込のときだけ、対象から外れた裁定を掃除する。upsert は qa_id 単位で行うため、
  // これをやらないと重複質問の古い方 (改定前の裁定) や公式から消えた裁定が残り続ける。
  //
  // qa_id を持たない ruling 行は、URL 単位で入れる旧 runIngestFaq('ruling', ...) 経路の残骸。
  // SQL の NOT IN は NULL に対して UNKNOWN を返し行が残ってしまうため、明示的に消す。
  let pruned = 0;
  if (opts.limit === undefined && list.length > 0) {
    const keep = list.map((i) => String(i.id));
    const deleted = await sql`
      DELETE FROM rule_chunks
      WHERE doc_type = 'ruling'
        AND (chunk_meta->>'qa_id' IS NULL OR chunk_meta->>'qa_id' NOT IN ${sql(keep)})
      RETURNING id
    `;
    pruned = deleted.length;
  }

  // 取込は qa_id 単位の DELETE+INSERT なので、前回付けた廃止印 (#92) はここで消えている。
  // レビュー済みの一覧から貼り直す。これを忘れると、週次 cron が回るたびに
  // 現行ルールと矛盾する裁定が RAG に復活する。
  const deprecated = await applyDeprecations(sql);

  console.log(
    `=== 裁定取り込み完了: ${inserted}件挿入 / ${skipped}スキップ / ${pruned}件削除 / 対象${list.length} / 廃止印${deprecated.flagged}件 ===`,
  );
  await closeDb();
  return { inserted, skipped, pruned, total: list.length, deprecated: deprecated.flagged };
}

/** CLI 引数: [limit]。省略時は全件。 */
export function parseRulingsArgs(argv: string[]): { limit?: number } {
  const n = argv[0] ? parseInt(argv[0], 10) : NaN;
  return Number.isFinite(n) && n > 0 ? { limit: n } : {};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runIngestRulings(parseRulingsArgs(process.argv.slice(2)))
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Error:", err);
      process.exit(1);
    });
}
