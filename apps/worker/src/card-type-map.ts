import type { CardType } from "@dm-ai/core";

/** 公式サイト表記 → CardType。前方一致で判定する (「進化クリーチャー」等の派生を吸収) */
const TYPE_PATTERNS: Array<[pattern: RegExp, type: CardType]> = [
  [/スター進化クリーチャー/, "star_evolution_creature"],
  [/クリーチャー/, "creature"], // 「進化クリーチャー」「タマシード/クリーチャー」等もここに落ちる
  [/呪文/, "spell"],
  [/クロスギア/, "cross_gear"],
  [/城/, "castle"],
  [/ウエポン|ウェポン/, "weapon"],
  [/フィールド/, "field"],
  [/タマシード/, "tamaseed"],
];

/** 変換できない場合は null (呼び出し側で warn してスキップ判断) */
export function normalizeCardType(raw: string): CardType | null {
  for (const [pattern, type] of TYPE_PATTERNS) {
    if (pattern.test(raw)) return type;
  }
  return null;
}
