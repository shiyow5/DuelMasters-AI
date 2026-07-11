import { MAX_COPIES } from "@dm-ai/core";

export interface RegulationSets {
  /** プレミアム殿堂 (採用禁止) */
  banned: Set<string>;
  /** 殿堂入り (1枚制限) */
  limited: Set<string>;
}

/** regulations の行を分類する (「プレミアム殿堂コンビ」は autoBuild では制約しない) */
export function classifyRegulations(
  rows: Array<{ card_name: string; restriction_type: string }>
): RegulationSets {
  const banned = new Set<string>();
  const limited = new Set<string>();
  for (const row of rows) {
    if (row.restriction_type === "プレミアム殿堂") banned.add(row.card_name);
    else if (row.restriction_type === "殿堂入り") limited.add(row.card_name);
  }
  return { banned, limited };
}

/** 必須カードに殿堂制約を適用する */
export function applyRegulationToRequired(
  requiredCards: string[],
  reg: RegulationSets
): { adopted: Array<{ name: string; count: number }>; warnings: string[] } {
  const adopted: Array<{ name: string; count: number }> = [];
  const warnings: string[] = [];
  for (const name of requiredCards) {
    if (reg.banned.has(name)) {
      warnings.push(`「${name}」はプレミアム殿堂のため採用できません`);
    } else if (reg.limited.has(name)) {
      adopted.push({ name, count: 1 });
    } else {
      adopted.push({ name, count: MAX_COPIES });
    }
  }
  return { adopted, warnings };
}
