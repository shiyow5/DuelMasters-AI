/**
 * 総合ゲームルール PDF の URL / バージョン解決 (純粋関数)。
 *
 * ingest-rules.ts から分離してある。あちらは pdf-parse を top-level import するため、
 * 純粋関数のテストがそれを引きずり込んでしまう (pdf-parse@1.1.4 は ESM 経由で読まれると
 * デバッグ経路に入りテスト用 PDF を同期読みしうる)。ここは副作用ゼロに保つ。
 */
import { OFFICIAL_SITE_BASE_URL } from "./constants.js";

/**
 * ルール改訂ページの HTML から総合ゲームルール PDF の URL を取り出す。
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

/** PDF 本文からバージョンを取り出す。例: "Ver.1.50" → "1.50" */
export function extractVersion(text: string): string {
  return text.match(/Ver\.\s*([\d.]+)/)?.[1] ?? "unknown";
}
