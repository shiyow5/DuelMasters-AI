/**
 * 殿堂レギュレーション取り込みジョブ
 */
import * as cheerio from "cheerio";
import { getSql, closeDb } from "@dm-ai/db";

const REGULATION_URL =
  "https://dm.takaratomy.co.jp/rule/regulation/";

async function main() {
  console.log("=== 殿堂レギュレーション取り込み開始 ===");

  const res = await fetch(REGULATION_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);

  const sql = getSql();
  let count = 0;

  // 殿堂入り・プレミアム殿堂セクションをパース
  const sections = [
    { selector: ".premium-dendou", type: "プレミアム殿堂" },
    { selector: ".dendou", type: "殿堂入り" },
    { selector: ".premium-combi", type: "プレミアム殿堂コンビ" },
  ];

  for (const section of sections) {
    $(section.selector).find("li, .card-name, tr").each((_, el) => {
      const cardName = $(el).text().trim();
      if (!cardName || cardName.length > 100) return;

      // バッファに追加（後でバッチ挿入）
      regulations.push({
        format: "original",
        restriction_type: section.type,
        card_name: cardName,
      });
    });
  }

  // 既存データ削除 → 再挿入
  await sql`DELETE FROM regulations`;

  for (const reg of regulations) {
    await sql`
      INSERT INTO regulations (format, restriction_type, card_name, effective_from)
      VALUES (${reg.format}, ${reg.restriction_type}, ${reg.card_name}, '2024-01-01')
    `;
    count++;
  }

  console.log(`=== 殿堂レギュレーション取り込み完了: ${count}件 ===`);
  await closeDb();
}

const regulations: Array<{
  format: string;
  restriction_type: string;
  card_name: string;
}> = [];

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
