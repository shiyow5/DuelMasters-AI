/**
 * ルールPDF取り込みジョブ
 * 公式総合ルールPDFをダウンロード → パース → チャンク化 → 埋め込み → DB格納
 */
import pdf from "pdf-parse";
import { embed } from "@dm-ai/core";
import { getSql, closeDb } from "@dm-ai/db";
import { chunkRuleText } from "@dm-ai/rag";
import { OFFICIAL_SITE_BASE_URL } from "../constants.js";
import { sleep } from "../lib.js";

const RULES_PDF_URL = `${OFFICIAL_SITE_BASE_URL}/rule/pdf/dm_comprehensive_rules.pdf`;

const BATCH_SIZE = 20;
const VERSION = "1.49";

async function main() {
  console.log("=== ルールPDF取り込み開始 ===");

  // 1. PDFダウンロード
  console.log(`PDFダウンロード中: ${RULES_PDF_URL}`);
  const response = await fetch(RULES_PDF_URL);
  if (!response.ok) {
    throw new Error(`PDF download failed: ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());

  // 2. PDFパース
  console.log("PDFパース中...");
  const parsed = await pdf(buffer);
  console.log(`ページ数: ${parsed.numpages}, テキスト長: ${parsed.text.length}`);

  // 3. チャンク化
  console.log("チャンク化中...");
  const chunks = chunkRuleText(parsed.text);
  console.log(`チャンク数: ${chunks.length}`);

  // 4. 既存データ削除 (同バージョン)
  const sql = getSql();
  await sql`
    DELETE FROM rule_chunks
    WHERE doc_type = 'comprehensive_rules' AND version = ${VERSION}
  `;
  console.log("既存データ削除完了");

  // 5. バッチで埋め込み生成 → DB格納
  let processed = 0;
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const texts = batch.map((c) => c.text);

    console.log(
      `埋め込み生成中... ${i + 1}-${Math.min(i + BATCH_SIZE, chunks.length)}/${chunks.length}`,
    );

    const embeddings = await embed(texts);
    if (embeddings.length !== texts.length) {
      throw new Error(
        `embed() が ${texts.length} 件中 ${embeddings.length} 件しか返しませんでした`,
      );
    }

    // DB挿入
    for (let j = 0; j < batch.length; j++) {
      const chunk = batch[j];
      const vecStr = `[${(embeddings[j] ?? []).join(",")}]`;

      await sql`
        INSERT INTO rule_chunks (doc_type, version, chunk_text, chunk_meta, embedding)
        VALUES (
          'comprehensive_rules',
          ${VERSION},
          ${chunk.text},
          ${sql.json(chunk.meta)},
          ${vecStr}::vector
        )
      `;
    }

    processed += batch.length;
    console.log(`進捗: ${processed}/${chunks.length}`);

    // レート制限対策
    if (i + BATCH_SIZE < chunks.length) {
      await sleep(500);
    }
  }

  console.log(`=== ルールPDF取り込み完了: ${processed}チャンク ===`);
  await closeDb();
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
