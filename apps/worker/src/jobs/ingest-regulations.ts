/**
 * 殿堂レギュレーション取り込みジョブ
 */
import * as cheerio from "cheerio";
import { getSql, closeDb } from "@dm-ai/db";
import { OFFICIAL_SITE_BASE_URL } from "../constants.js";

const REGULATION_URL = `${OFFICIAL_SITE_BASE_URL}/rule/regulation/`;

/** 施行日はスクレイピング元から取得していない (既知の制限。仕様変更はしない) */
const EFFECTIVE_FROM = "2024-01-01";

async function main() {
  console.log("=== 殿堂レギュレーション取り込み開始 ===");

  const res = await fetch(REGULATION_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);

  const sql = getSql();

  const sections = [
    { selector: ".premium-dendou", type: "プレミアム殿堂" },
    { selector: ".dendou", type: "殿堂入り" },
    { selector: ".premium-combi", type: "プレミアム殿堂コンビ" },
  ];

  const regulations: Array<{
    format: string;
    restriction_type: string;
    card_name: string;
  }> = [];

  for (const section of sections) {
    $(section.selector)
      .find("li, .card-name, tr")
      .each((_, el) => {
        const cardName = $(el).text().trim();
        if (!cardName || cardName.length > 100) return;
        regulations.push({
          format: "original",
          restriction_type: section.type,
          card_name: cardName,
        });
      });
  }

  if (regulations.length === 0) {
    throw new Error(
      "殿堂レギュレーションを1件も取得できませんでした。ページ構造が変わった可能性があります。既存データは変更せず中断します",
    );
  }

  // original のみ入れ替える (他 format のデータは保持)
  await sql`DELETE FROM regulations WHERE format = 'original'`;

  let count = 0;
  for (const reg of regulations) {
    await sql`
      INSERT INTO regulations (format, restriction_type, card_name, effective_from)
      VALUES (${reg.format}, ${reg.restriction_type}, ${reg.card_name}, ${EFFECTIVE_FROM})
    `;
    count++;
  }

  console.log(`=== 殿堂レギュレーション取り込み完了: ${count}件 ===`);
  await closeDb();
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
