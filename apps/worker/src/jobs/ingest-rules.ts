/**
 * 総合ゲームルール取り込みジョブ。
 *
 * 公式の「総合ゲームルール」PDF をダウンロード → パース → チャンク化 → 埋め込み → DB格納。
 * チャンクには条番号 (例: 609.8) が meta.article として入るため、回答時に条文を引用できる。
 *
 * PDF の URL は改訂のたびに変わる (例: /img/dm_rule_20260410_4.pdf) ので、
 * ルール改訂ページ (/rule/rulechange/) のリンクから現行版を自動発見する。
 * バージョンも PDF 本文の「Ver.1.50」表記から読み取り、ハードコードしない。
 */
import { pathToFileURL } from "node:url";
import pdf from "pdf-parse";
import { embed } from "@dm-ai/core";
import { getSql, closeDb } from "@dm-ai/db";
import { chunkRuleText } from "@dm-ai/rag";
import { OFFICIAL_SITE_BASE_URL } from "../constants.js";
import { sleep } from "../lib.js";

const RULE_CHANGE_URL = `${OFFICIAL_SITE_BASE_URL}/rule/rulechange/`;
const DOC_TYPE = "comprehensive_rules";
const BATCH_SIZE = 20;

/**
 * ルール改訂ページの HTML から総合ゲームルール PDF の URL を取り出す (純粋関数・テスト対象)。
 *
 * 同じページには競技ルール (dm_competition_rule_*) やデュエパーティー (dhueparty_rule_*) の
 * PDF も並ぶため、`dm_rule_<日付>` のものだけを対象にする。複数あればファイル名の日付が
 * 最も新しいものを選ぶ。
 */
export function findRulesPdfUrl(html: string, baseUrl = OFFICIAL_SITE_BASE_URL): string | null {
  const hrefs = [...html.matchAll(/href="([^"]+\.pdf)"/g)].map((m) => m[1]);
  const candidates = hrefs
    .map((href) => {
      const file = href.split("/").pop() ?? "";
      const m = file.match(/^dm_rule_(\d{8})/);
      return m ? { href, date: m[1] } : null;
    })
    .filter((c): c is { href: string; date: string } => c !== null);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.date.localeCompare(a.date));
  const href = candidates[0].href;
  return href.startsWith("http") ? href : `${baseUrl}${href}`;
}

/** PDF 本文からバージョンを取り出す (純粋関数・テスト対象)。例: "Ver.1.50" → "1.50" */
export function extractVersion(text: string): string {
  return text.match(/Ver\.\s*([\d.]+)/)?.[1] ?? "unknown";
}

export async function runIngestRules(): Promise<{ chunks: number; version: string }> {
  console.log("=== 総合ゲームルール取り込み開始 ===");

  // 1. 現行 PDF の URL を発見
  const pageRes = await fetch(RULE_CHANGE_URL);
  if (!pageRes.ok) throw new Error(`ルール改訂ページ取得失敗: HTTP ${pageRes.status}`);
  const pdfUrl = findRulesPdfUrl(await pageRes.text());
  if (!pdfUrl) throw new Error("総合ゲームルール PDF のリンクが見つかりませんでした");
  console.log(`PDF ダウンロード中: ${pdfUrl}`);

  // 2. ダウンロード + パース
  const res = await fetch(pdfUrl);
  if (!res.ok) throw new Error(`PDF ダウンロード失敗: HTTP ${res.status}`);
  const parsed = await pdf(Buffer.from(await res.arrayBuffer()));
  const version = extractVersion(parsed.text);
  console.log(`ページ数: ${parsed.numpages} / バージョン: ${version}`);

  // 3. チャンク化 (条番号は meta.article に入る)
  const chunks = chunkRuleText(parsed.text);
  const withArticle = chunks.filter((c) => c.meta.article).length;
  console.log(`チャンク数: ${chunks.length} (条番号あり: ${withArticle})`);
  if (chunks.length === 0) throw new Error("チャンクが0件でした (PDF の構造が変わった可能性)");

  // 4. 埋め込みを先に全件作る。DB の入れ替えは最後にまとめて行う。
  const sql = getSql();
  const embeddings: number[][] = [];
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const vecs = await embed(batch.map((c) => c.text));
    if (vecs.length !== batch.length) {
      throw new Error(`embed() が ${batch.length} 件中 ${vecs.length} 件しか返しませんでした`);
    }
    embeddings.push(...vecs);
    console.log(`埋め込み: ${Math.min(i + BATCH_SIZE, chunks.length)}/${chunks.length}`);
    if (i + BATCH_SIZE < chunks.length) await sleep(500);
  }

  // 5. 差し替え。旧版の条文が残ると RAG が古いルールを引くため doc_type ごと入れ替える。
  // 失敗時に条文が消えたままにならないよう、削除と挿入は同一トランザクションで行う。
  await sql.begin(async (tx) => {
    const txSql = tx as unknown as typeof sql;
    await txSql`DELETE FROM rule_chunks WHERE doc_type = ${DOC_TYPE}`;
    for (let i = 0; i < chunks.length; i++) {
      await txSql`
        INSERT INTO rule_chunks (doc_type, version, chunk_text, chunk_meta, embedding)
        VALUES (
          ${DOC_TYPE}, ${version}, ${chunks[i].text}, ${sql.json(chunks[i].meta)},
          ${`[${embeddings[i].join(",")}]`}::vector
        )
      `;
    }
  });

  console.log(`=== 総合ゲームルール取り込み完了: ${chunks.length}チャンク (Ver.${version}) ===`);
  await closeDb();
  return { chunks: chunks.length, version };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runIngestRules()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Error:", err);
      process.exit(1);
    });
}
