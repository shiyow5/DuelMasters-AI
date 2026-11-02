import { MAX_COPIES } from "@dm-ai/core";
import {
  buildRegulationIndex,
  lookupRegulation,
  type RegulationIndex,
  type RegulationRow,
} from "./regulation-index.js";

/**
 * autoBuild 用の殿堂制約。
 *
 * 以前は `banned` / `limited` を `card_name` そのままの Set で持ち、`has(name)` の完全一致で
 * 引いていたため、中黒・引用符・空白のゆれやツインパクトの片面名で殿堂制約がすり抜けた (#167)。
 * いまは validator の `checkRestrictions` と同じ索引 ({@link buildRegulationIndex}) を持ち、
 * 名前は正規化キー + ツインパクト片面 (両向き) で引く。
 */
export interface RegulationSets {
  /** プレミアム殿堂 (採用禁止) か */
  isBanned(name: string): boolean;
  /** 殿堂入り (1枚制限) か */
  isLimited(name: string): boolean;
}

/**
 * regulations の行を分類する (「プレミアム殿堂コンビ」は autoBuild では制約しない)。
 *
 * 照合は validator と共通の索引で行うので、全体名の優先・片面同士の衝突時は強い方、
 * といった規則も `checkRestrictions` と同じになる。
 */
export function classifyRegulations(rows: readonly RegulationRow[]): RegulationSets {
  const index: RegulationIndex = buildRegulationIndex(rows);
  const restrictionOf = (name: string) => lookupRegulation(index, name)?.restriction;
  return {
    isBanned: (name) => restrictionOf(name) === "プレミアム殿堂",
    isLimited: (name) => restrictionOf(name) === "殿堂入り",
  };
}

/** 必須カードに殿堂制約を適用する */
export function applyRegulationToRequired(
  requiredCards: string[],
  reg: RegulationSets,
): { adopted: Array<{ name: string; count: number }>; warnings: string[] } {
  const adopted: Array<{ name: string; count: number }> = [];
  const warnings: string[] = [];
  for (const name of requiredCards) {
    if (reg.isBanned(name)) {
      warnings.push(`「${name}」はプレミアム殿堂のため採用できません`);
    } else if (reg.isLimited(name)) {
      adopted.push({ name, count: 1 });
    } else {
      adopted.push({ name, count: MAX_COPIES });
    }
  }
  return { adopted, warnings };
}
