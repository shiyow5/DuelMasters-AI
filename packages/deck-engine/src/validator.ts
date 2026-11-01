import { DECK_SIZE, MAX_COPIES, type Format, type ValidationResult } from "@dm-ai/core";
import { getSql } from "@dm-ai/db";
import type { ParsedDeck } from "./parser.js";
import {
  mergeEntriesByName,
  regulationNameKey,
  twinpactSideKeys,
  type MergedEntry,
} from "./card-name.js";

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
 * 規制の強さ。片面名のキーが2つの規制にぶつかったときは強いほうを採る
 * (弱いほうを採ると、すり抜けの穴を新しく作ることになる)。
 */
const RESTRICTION_STRENGTH: Record<string, number> = {
  プレミアム殿堂: 3,
  殿堂入り: 2,
  プレミアム殿堂コンビ: 1,
};

function strength(restriction: string): number {
  return RESTRICTION_STRENGTH[restriction] ?? 0;
}

/** 照合で当たった規制1件 */
interface RegHit {
  /** 規制の全体名のキー (同じ規制に当たったデッキの行を合算するための ID) */
  id: string;
  restriction: string;
}

/**
 * 殿堂・プレミアム殿堂の判定 (DB に触らない純粋関数。テスト用に export)。
 *
 * `merged` は {@link mergeEntriesByName} で正規化キーごとに合算済みのデッキ。
 * regulations 側の名前も同じキーにして照合する。
 *
 * ## ツインパクトの片面名 (#167)
 *
 * 規制が `A / B` でデッキが `A` だけ (またはその逆) でも当たるようにする。
 * - 規制側: 全体名 `a/b` に加え、片面 `a` `b` でも regMap に登録する。
 *   **全体名での登録が常に優先**し、片面キーが別の規制の全体名と同じなら上書きしない。
 *   片面キー同士がぶつかったら強い規制を採る。
 * - デッキ側: 全体名で当たらなければ、片面 `a` `b` でも引く (規制が片面だけで載っている場合)。
 * - `A / B` と `A` を別の行に書いても同じ規制として**枚数を合算**する
 *   (殿堂入り1枚制限を行の書き分けですり抜けさせない)。
 */
export function checkRestrictions(
  merged: Map<string, MergedEntry>,
  regulations: readonly RegulationRow[],
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  const regMap = new Map<string, RegHit>();
  // 1) 全体名。完全一致はいつも片面より優先する。
  for (const reg of regulations) {
    const key = regulationNameKey(reg.card_name);
    regMap.set(key, { id: key, restriction: reg.restriction_type });
  }
  const fullKeys = new Set(regMap.keys());
  // 2) ツインパクトの片面。全体名を上書きしない。片面同士の衝突は強い方。
  for (const reg of regulations) {
    const id = regulationNameKey(reg.card_name);
    for (const side of twinpactSideKeys(id)) {
      if (fullKeys.has(side)) continue;
      const prev = regMap.get(side);
      if (!prev || strength(reg.restriction_type) > strength(prev.restriction)) {
        regMap.set(side, { id, restriction: reg.restriction_type });
      }
    }
  }

  // 同じ規制に当たった行をまとめる (並びは最初に当たった順)
  const hits = new Map<string, { restriction: string; names: string[]; count: number }>();
  for (const [key, entry] of merged) {
    const hit = lookup(regMap, key);
    if (!hit) continue;
    const agg = hits.get(hit.id);
    if (agg) {
      agg.names.push(entry.name);
      agg.count += entry.count;
    } else {
      hits.set(hit.id, { restriction: hit.restriction, names: [entry.name], count: entry.count });
    }
  }

  for (const { restriction, names, count } of hits.values()) {
    const name = names.join("」「");
    switch (restriction) {
      case "プレミアム殿堂":
        errors.push(`「${name}」はプレミアム殿堂のため使用できません`);
        break;
      case "殿堂入り":
        if (count > 1) {
          errors.push(`「${name}」は殿堂入りのため1枚までです (現在: ${count}枚)`);
        }
        break;
      case "プレミアム殿堂コンビ":
        warnings.push(`「${name}」はプレミアム殿堂コンビです。組み合わせを確認してください`);
        break;
    }
  }

  return { errors, warnings };
}

/** デッキの1行のキーで規制を引く。全体名 → ツインパクトの片面 (当たった中で強い方) の順。 */
function lookup(regMap: Map<string, RegHit>, key: string): RegHit | undefined {
  const exact = regMap.get(key);
  if (exact) return exact;
  let best: RegHit | undefined;
  for (const side of twinpactSideKeys(key)) {
    const hit = regMap.get(side);
    if (hit && (!best || strength(hit.restriction) > strength(best.restriction))) best = hit;
  }
  return best;
}
