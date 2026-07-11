import * as cheerio from "cheerio";

/** HTML から本文テキストを抽出する (script/style/nav/header/footer を除去) */
export function extractTextFromHtml(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, nav, header, footer").remove();
  return $("body")
    .text()
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
