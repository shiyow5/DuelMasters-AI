/**
 * 殿堂レギュレーション取り込みジョブ。
 * 公式サイト刷新後の /rule/regulation/ は h2 (制限種別) の配下に あ行/か行… の
 * <li><a data-href="/card/detail/?id=..."> リストが並ぶ構造。「殿堂解除」節は除外する。
 */
import { pathToFileURL } from "node:url";
import * as cheerio from "cheerio";
import { getSql, closeDb } from "@dm-ai/db";
import { OFFICIAL_SITE_BASE_URL } from "../constants.js";
import { fetchWithRetry } from "../lib.js";

const REGULATION_URL = `${OFFICIAL_SITE_BASE_URL}/rule/regulation/`;
/** 施行日はページから確実に取れないため既定値 (既知の制限)。 */
const EFFECTIVE_FROM = "2024-01-01";

/** h2 見出しテキスト → 制限種別。順序は「より限定的な語」を先に判定する。 */
const CATEGORIES: Array<{ re: RegExp; type: string }> = [
  { re: /使用禁止カード/, type: "使用禁止" },
  { re: /プレミアム殿堂超次元コンビ/, type: "プレミアム殿堂コンビ" },
  { re: /プレミアム殿堂コンビカード/, type: "プレミアム殿堂コンビ" },
  { re: /プレミアム殿堂入りカード/, type: "プレミアム殿堂" },
  { re: /殿堂入りカード/, type: "殿堂入り" },
];

export interface RegulationEntry {
  restriction_type: string;
  card_name: string;
  card_id?: string;
}

/** 殿堂ページ HTML から制限カード一覧を抽出する (純粋関数・テスト対象)。 */
export function parseRegulations(html: string): RegulationEntry[] {
  const $ = cheerio.load(html);
  const out: RegulationEntry[] = [];
  const seen = new Set<string>();
  let current: string | null = null;
  let released = false; // 「殿堂解除」節に入ったら次の h2 まで除外

  $("h2, h3, h4, li a[data-href^='/card/detail'], li a[href^='/card/detail']").each((_, el) => {
    const tag = (el as { tagName?: string }).tagName?.toLowerCase();
    if (tag === "h2") {
      const t = $(el).text();
      current = CATEGORIES.find((c) => c.re.test(t))?.type ?? null;
      released = false;
    } else if (tag === "h3" || tag === "h4") {
      if (/解除/.test($(el).text())) released = true;
    } else {
      if (!current || released) return;
      const name = $(el)
        .text()
        .replace(/[《》]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      // 広告/プロモ導線 (【今すぐ】…等) やカード名でないものを除外
      if (!name || name.length > 60 || /[【】]/.test(name)) return;
      const href = $(el).attr("data-href") ?? $(el).attr("href") ?? "";
      const cardId = href.match(/id=([^&]+)/)?.[1];
      const key = `${current}|${name}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ restriction_type: current, card_name: name, card_id: cardId });
    }
  });
  return out;
}

export async function runIngestRegulations(): Promise<{ inserted: number }> {
  console.log("=== 殿堂レギュレーション取り込み開始 ===");
  const html = await fetchWithRetry(REGULATION_URL);
  const entries = parseRegulations(html);
  if (entries.length === 0) {
    throw new Error(
      "殿堂レギュレーションを1件も取得できませんでした。ページ構造が変わった可能性があります。既存データは変更せず中断します",
    );
  }

  const sql = getSql();
  // original のみ入れ替える (他 format のデータは保持)。失敗時に消えたままにならないよう transaction。
  await sql.begin(async (tx) => {
    const txSql = tx as unknown as typeof sql;
    await txSql`DELETE FROM regulations WHERE format = 'original'`;
    for (const e of entries) {
      await txSql`
        INSERT INTO regulations (format, restriction_type, card_name, effective_from)
        VALUES ('original', ${e.restriction_type}, ${e.card_name}, ${EFFECTIVE_FROM})
      `;
    }
  });

  const byType = entries.reduce<Record<string, number>>((acc, e) => {
    acc[e.restriction_type] = (acc[e.restriction_type] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`=== 殿堂レギュレーション取り込み完了: ${entries.length}件 ===`);
  console.log(
    `  内訳: ${Object.entries(byType)
      .map(([k, v]) => `${k}=${v}`)
      .join(" / ")}`,
  );
  await closeDb();
  return { inserted: entries.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runIngestRegulations()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Error:", err);
      process.exit(1);
    });
}
