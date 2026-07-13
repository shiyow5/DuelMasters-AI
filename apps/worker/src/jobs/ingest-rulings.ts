/**
 * 公式「よくある質問(裁定)」を RAG (rule_chunks) に取り込むジョブ。
 * 公式サイトの WP REST API のカスタム投稿タイプ `qa_old` (3000件超) が裁定 Q&A の一次情報源。
 * API は質問(title)とリンクのみ返すため、回答は各 HTML ページの .answer から取得する。
 * doc_type='ruling' で qa_id 単位に冪等 upsert。
 *
 * 公式サイトには改定前の裁定がそのまま残っており、同じ質問で結論が逆のペアがある。
 * 古い方を取り込むと RAG が現行ルールに反する答えを引くため、質問文で名寄せして
 * qa_id の新しい方だけを採る (dedupeRulingList)。
 */
import { pathToFileURL } from "node:url";
import * as cheerio from "cheerio";
import { getSql, closeDb } from "@dm-ai/db";
import { embed } from "@dm-ai/core";
import { sleep, fetchWithRetry } from "../lib.js";
import { OFFICIAL_SITE_BASE_URL } from "../constants.js";

const QA_API = `${OFFICIAL_SITE_BASE_URL}/wp-json/wp/v2/qa_old`;
const LIST_PER_PAGE = 100;
const EMBED_FLUSH = 20;
const FETCH_DELAY_MS = 150;

export interface RulingItem {
  id: number;
  question: string;
  link: string;
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

/** qa_old API をページングして裁定の一覧 (id/質問/リンク) を集める。 */
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
      out.push({ id: p.id, question: htmlToText(p.title?.rendered ?? ""), link: p.link });
      if (limit && out.length >= limit) return out.slice(0, limit);
    }
    if (arr.length < LIST_PER_PAGE) break;
  }
  return out;
}

/**
 * 質問文の同一性判定用に正規化する。
 * 「【基本ルール】」等の接頭ラベルは改定時に付くことがあるので落とし、空白差・半角カナ差も潰す。
 */
function normalizeQuestion(q: string): string {
  return q
    .normalize("NFKC")
    .replace(/【[^】]*】/g, "")
    .replace(/\s+/g, "");
}

/**
 * 同じ質問の裁定が複数あれば、qa_id が最大 (＝新しい) ものだけ残す。並び順は元のまま。
 * 公式サイトに残る改定前の裁定が現行ルールと矛盾するため、新しい方へ寄せる。
 */
export function dedupeRulingList(items: RulingItem[]): RulingItem[] {
  const newestId = new Map<string, number>();
  for (const item of items) {
    const key = normalizeQuestion(item.question);
    const current = newestId.get(key);
    if (current === undefined || item.id > current) newestId.set(key, item.id);
  }
  return items.filter((item) => newestId.get(normalizeQuestion(item.question)) === item.id);
}

export async function runIngestRulings(
  opts: { limit?: number; version?: string } = {},
): Promise<{ inserted: number; skipped: number; pruned: number; total: number }> {
  const sql = getSql();
  const version = opts.version ?? today();
  const fetched = await fetchRulingList(opts.limit);
  const list = dedupeRulingList(fetched);
  const duplicates = fetched.length - list.length;
  console.log(
    `=== 裁定取り込み開始: 対象 ${list.length}件 (重複質問 ${duplicates}件を新しい裁定へ寄せた) ===`,
  );

  let inserted = 0;
  let skipped = 0;
  let buffer: Array<{ qaId: number; url: string; text: string }> = [];

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
          VALUES ('ruling', ${version}, ${b.text}, ${sql.json({ url: b.url, qa_id: b.qaId })}, ${vec}::vector)
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
      const q = question || item.question;
      if (!answer) {
        skipped++;
        continue;
      }
      buffer.push({ qaId: item.id, url: item.link, text: `Q: ${q}\nA: ${answer}` });
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
  let pruned = 0;
  if (opts.limit === undefined && list.length > 0) {
    const keep = list.map((i) => String(i.id));
    const deleted = await sql`
      DELETE FROM rule_chunks
      WHERE doc_type = 'ruling' AND chunk_meta->>'qa_id' NOT IN ${sql(keep)}
      RETURNING id
    `;
    pruned = deleted.length;
  }

  console.log(
    `=== 裁定取り込み完了: ${inserted}件挿入 / ${skipped}スキップ / ${pruned}件削除 / 対象${list.length} ===`,
  );
  await closeDb();
  return { inserted, skipped, pruned, total: list.length };
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
