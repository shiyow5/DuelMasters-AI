import type { Citation } from "./types";

/**
 * 出典ラベル。`packages/agent/src/graph.ts` の sourceLabel と同じ分類に揃える。
 *
 * 【総合ルール】が現行の一次情報、【裁定Q&A】は個別事例の公式回答だが改定前の古い回答が
 * 混じっていることがある。どの資料に基づく回答なのかをユーザーが判断できるようにする。
 */
export function citationLabel(c: Citation): string {
  switch (c.doc_type) {
    case "comprehensive_rules":
      return c.article ? `総合ルール ${c.article}` : "総合ルール";
    case "ruling":
      return "裁定Q&A";
    case "faq":
      return "FAQ";
    case "card":
      return typeof c.name === "string" ? `カード: ${c.name}` : "カード";
    default:
      return "参考";
  }
}

/** 一次情報 (総合ルール) かどうか。UI で強調するのに使う。 */
export function isPrimarySource(c: Citation): boolean {
  return c.doc_type === "comprehensive_rules";
}

/**
 * 同じ条文が複数ヒットすることがあるので重複を畳む。
 * 条文番号があればそれを、無ければ本文の先頭を鍵にする。
 */
export function dedupeCitations(citations: Citation[]): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const c of citations) {
    const key =
      typeof c.article === "string" && c.article !== ""
        ? `article:${c.article}`
        : `text:${(c.text ?? "").slice(0, 40)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}
