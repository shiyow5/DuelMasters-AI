import { DECK_SIZE, MAX_COPIES, type Format, type ValidationResult } from "@dm-ai/core";
import { getSql } from "@dm-ai/db";
import type { ParsedDeck } from "./parser.js";

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

  // 同名カード4枚制限
  for (const entry of deck.entries) {
    if (entry.count > MAX_COPIES) {
      errors.push(`「${entry.name}」は最大${MAX_COPIES}枚までです (現在: ${entry.count}枚)`);
    }
  }

  // 殿堂チェック
  try {
    const sql = getSql();
    const regulations = await sql`
      SELECT card_name, restriction_type
      FROM regulations
      WHERE format = ${format}
    `;

    const regMap = new Map<string, string>();
    for (const reg of regulations) {
      regMap.set(reg.card_name as string, reg.restriction_type as string);
    }

    for (const entry of deck.entries) {
      const restriction = regMap.get(entry.name);
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
          warnings.push(
            `「${entry.name}」はプレミアム殿堂コンビです。組み合わせを確認してください`,
          );
          break;
      }
    }
  } catch {
    warnings.push("殿堂データベースに接続できないため、殿堂チェックをスキップしました");
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
