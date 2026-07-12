/**
 * FAQ・裁定ページを RAG (rule_chunks) に取り込むジョブ。
 * HTML → 本文抽出 → Q&A チャンク化 → 埋め込み → INSERT。URL 単位で冪等。
 */
import { pathToFileURL } from "node:url";
import { getSql, closeDb } from "@dm-ai/db";
import { embed } from "@dm-ai/core";
import { chunkFaqText, extractTextFromHtml, type Chunk } from "@dm-ai/rag";
import { fetchWithRetry } from "../lib.js";

const BATCH_SIZE = 20;
const VALID_DOC_TYPES = ["faq", "ruling"] as const;
type FaqDocType = (typeof VALID_DOC_TYPES)[number];

/** version 用の取り込み日 (YYYY-MM-DD)。テストでは引数で固定する */
function today(): string {
  return new Date().toISOString().split("T")[0];
}

export async function runIngestFaq(
  docType: FaqDocType,
  urls: string[],
  version = today(),
): Promise<{ inserted: number; skipped: string[] }> {
  const sql = getSql();
  let inserted = 0;
  const skipped: string[] = [];

  for (const url of urls) {
    const html = await fetchWithRetry(url);
    const chunks = chunkFaqText(extractTextFromHtml(html));
    if (chunks.length === 0) {
      console.warn(`チャンク0件のためスキップ (既存データは保持): ${url}`);
      skipped.push(url);
      continue;
    }

    // 埋め込みは削除の前に全チャンク分を生成しておく。
    // embed/生成の途中で失敗しても DELETE 前なので既存データは消えない。
    const rows: Array<{
      text: string;
      meta: Chunk["meta"] & { url: string };
      vec: string;
    }> = [];
    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);
      const embeddings = await embed(batch.map((c) => c.text));
      for (let j = 0; j < batch.length; j++) {
        const meta = { ...batch[j].meta, url };
        const vec = `[${(embeddings[j] ?? []).join(",")}]`;
        rows.push({ text: batch[j].text, meta, vec });
      }
    }

    // 削除と挿入を1トランザクションにまとめ、失敗時に旧チャンクが消えたままになるのを防ぐ (冪等)。
    // postgres.js の TransactionSql 型は Omit の制約でタグ付きテンプレートの呼び出しシグネチャが
    // 落ちてしまう既知の型定義上の制約があるため、実体は同一の sql と同じ形なので型を合わせてキャストする。
    await sql.begin(async (tx) => {
      const txSql = tx as unknown as typeof sql;
      await txSql`DELETE FROM rule_chunks WHERE doc_type = ${docType} AND chunk_meta->>'url' = ${url}`;
      for (const row of rows) {
        await txSql`
          INSERT INTO rule_chunks (doc_type, version, chunk_text, chunk_meta, embedding)
          VALUES (${docType}, ${version}, ${row.text}, ${sql.json(row.meta)}, ${row.vec}::vector)
        `;
      }
    });
    inserted += rows.length;
    console.log(`取り込み: ${url} (${chunks.length}チャンク)`);
  }

  console.log(
    `=== FAQ/裁定取り込み完了: ${inserted}チャンク挿入 / ${skipped.length}URLスキップ ===`,
  );
  await closeDb();
  return { inserted, skipped };
}

/** CLI 引数を検証する */
export function parseFaqArgs(argv: string[]): { docType: FaqDocType; urls: string[] } | null {
  const docType = argv[0];
  const urls = argv.slice(1).filter(Boolean);
  if (!VALID_DOC_TYPES.includes(docType as FaqDocType) || urls.length === 0) {
    return null;
  }
  return { docType: docType as FaqDocType, urls };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const parsed = parseFaqArgs(process.argv.slice(2));
  if (!parsed) {
    console.error("使用法: tsx src/jobs/ingest-faq.ts <faq|ruling> <url> [url...]");
    process.exit(1);
  }
  runIngestFaq(parsed.docType, parsed.urls)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Error:", err);
      process.exit(1);
    });
}
