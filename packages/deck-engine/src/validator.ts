import { DECK_SIZE, MAX_COPIES, type Format, type ValidationResult } from "@dm-ai/core";
import { getSql } from "@dm-ai/db";
import type { ParsedDeck } from "./parser.js";
import { mergeEntriesByName, regulationNameKey, type MergedEntry } from "./card-name.js";

/** regulations テーブルの1行 (照合に使う列だけ) */
export interface RegulationRow {
  card_name: string;
  restriction_type: string;
}

/**
 * デッキのレギュレーション準拠チェック
 */
export async function validateRegulation(
  deck: ParsedDeck,
  format: Format,
): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 枚数チェック
  if (deck.totalCards !== DECK_SIZE) {
    errors.push(`デッキは${DECK_SIZE}枚ちょうどである必要があります (現在: ${deck.totalCards}枚)`);
  }

  // カード名は正規化して、同じカードの複数行を合算してから判定する (B-02/B-03)
  const merged = mergeEntriesByName(deck.entries);

  // 同名カード4枚制限
  for (const entry of merged.values()) {
    if (entry.count > MAX_COPIES) {
      errors.push(`「${entry.name}」は最大${MAX_COPIES}枚までです (現在: ${entry.count}枚)`);
    }
  }

  // 殿堂チェック
  let regulations: RegulationRow[];
  try {
    const sql = getSql();
    const rows = await sql`
      SELECT card_name, restriction_type
      FROM regulations
      WHERE format = ${format}
    `;
    regulations = rows.map((r) => ({
      card_name: r.card_name as string,
      restriction_type: r.restriction_type as string,
    }));
  } catch {
    warnings.push("殿堂データベースに接続できないため、殿堂チェックをスキップしました");
    return { valid: errors.length === 0, errors, warnings };
  }

  const result = checkRestrictions(merged, regulations);
  errors.push(...result.errors);
  warnings.push(...result.warnings);

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * 殿堂・プレミアム殿堂の判定 (DB に触らない純粋関数。テスト用に export)。
 *
 * `merged` は {@link mergeEntriesByName} で正規化キーごとに合算済みのデッキ。
 * regulations 側の名前も同じキーにして照合する。
 */
export function checkRestrictions(
  merged: Map<string, MergedEntry>,
  regulations: readonly RegulationRow[],
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  const regMap = new Map<string, string>();
  for (const reg of regulations) {
    regMap.set(regulationNameKey(reg.card_name), reg.restriction_type);
  }

  for (const [key, entry] of merged) {
    const restriction = regMap.get(key);
    if (!restriction) continue;

    switch (restriction) {
      case "プレミアム殿堂":
        errors.push(`「${entry.name}」はプレミアム殿堂のため使用できません`);
        break;
      case "殿堂入り":
        if (entry.count > 1) {
          errors.push(`「${entry.name}」は殿堂入りのため1枚までです (現在: ${entry.count}枚)`);
        }
        break;
      case "プレミアム殿堂コンビ":
        warnings.push(`「${entry.name}」はプレミアム殿堂コンビです。組み合わせを確認してください`);
        break;
    }
  }

  return { errors, warnings };
}
