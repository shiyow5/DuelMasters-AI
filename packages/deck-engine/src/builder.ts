import type { Format, DeckEntry } from "@dm-ai/core";
import { getSql } from "@dm-ai/db";

export interface BuildConstraints {
  /** 必須カード */
  requiredCards?: string[];
  /** 除外カード */
  excludeCards?: string[];
  /** 文明制約 */
  civilizations?: string[];
  /** 最大コスト */
  maxCost?: number;
}

export interface BuildResult {
  entries: DeckEntry[];
  totalCards: number;
  strategy: string;
  weaknesses: string[];
  alternatives: Array<{ original: string; replacement: string; reason: string }>;
}

/**
 * テーマに基づいてデッキを自動構築する
 */
export async function autoBuild(
  theme: string,
  format: Format,
  constraints: BuildConstraints = {}
): Promise<BuildResult> {
  const sql = getSql();
  const entries: DeckEntry[] = [];
  let totalCards = 0;

  // 1. 必須カード追加
  if (constraints.requiredCards) {
    for (const name of constraints.requiredCards) {
      entries.push({ name, count: 4 });
      totalCards += 4;
    }
  }

  // 2. テーマに関連するカードを検索
  const themeCards = await sql`
    SELECT name, cost, type, tags, civilizations, is_shield_trigger, is_rainbow
    FROM cards
    WHERE text ILIKE ${"%" + theme + "%"}
       OR name ILIKE ${"%" + theme + "%"}
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements_text(races) r WHERE r ILIKE ${"%" + theme + "%"}
       )
    ORDER BY cost ASC
    LIMIT 100
  `;

  // 3. 役割ごとにカードを選定
  const roleQuotas: Record<string, number> = {
    初動: 12,     // 2-3コスト帯
    フィニッシャー: 4,
    受け: 8,
    除去: 4,
    ドロー: 4,
    ブースト: 4,
  };

  const usedNames = new Set(entries.map((e) => e.name));

  // テーマカードから優先的に採用
  for (const card of themeCards) {
    if (totalCards >= 40) break;
    const name = card.name as string;
    if (usedNames.has(name)) continue;

    const tags = (card.tags as string[]) ?? [];
    const cost = card.cost as number;

    // 役割に基づいてカウント決定
    let count = 4;
    for (const tag of tags) {
      if (roleQuotas[tag] !== undefined && roleQuotas[tag] > 0) {
        count = Math.min(count, roleQuotas[tag]);
        roleQuotas[tag] -= count;
        break;
      }
    }

    // 高コストは枚数を絞る
    if (cost >= 7) count = Math.min(count, 2);

    if (totalCards + count > 40) count = 40 - totalCards;
    if (count <= 0) continue;

    entries.push({ name, count });
    usedNames.add(name);
    totalCards += count;
  }

  // 4. 不足分を汎用カードで補充
  if (totalCards < 40) {
    const fillers = await sql`
      SELECT name, cost, tags
      FROM cards
      WHERE name NOT IN ${sql(Array.from(usedNames).length > 0 ? Array.from(usedNames) : ["__none__"])}
        AND is_shield_trigger = true
      ORDER BY cost ASC
      LIMIT 20
    `;

    for (const filler of fillers) {
      if (totalCards >= 40) break;
      const name = filler.name as string;
      if (usedNames.has(name)) continue;
      const count = Math.min(4, 40 - totalCards);
      entries.push({ name, count });
      usedNames.add(name);
      totalCards += count;
    }
  }

  return {
    entries,
    totalCards,
    strategy: `「${theme}」をテーマとした構築です。`,
    weaknesses: analyzeWeaknesses(entries),
    alternatives: [],
  };
}

function analyzeWeaknesses(entries: DeckEntry[]): string[] {
  const weaknesses: string[] = [];
  const total = entries.reduce((s, e) => s + e.count, 0);
  if (total < 40) weaknesses.push(`カードが${total}枚しかありません (40枚必要)`);
  return weaknesses;
}

/**
 * デッキの改善提案を生成する
 */
export async function suggestReplacements(
  entries: DeckEntry[],
  goals: string[]
): Promise<Array<{ original: string; replacement: string; reason: string }>> {
  // 簡易版: goals に基づいてDBから候補を検索
  const sql = getSql();
  const suggestions: Array<{
    original: string;
    replacement: string;
    reason: string;
  }> = [];

  for (const goal of goals) {
    const candidates = await sql`
      SELECT name, text
      FROM cards
      WHERE text ILIKE ${"%" + goal + "%"}
         OR EXISTS (
           SELECT 1 FROM jsonb_array_elements_text(tags) t WHERE t = ${goal}
         )
      LIMIT 5
    `;

    for (const candidate of candidates) {
      suggestions.push({
        original: "",
        replacement: candidate.name as string,
        reason: `「${goal}」の強化候補`,
      });
    }
  }

  return suggestions;
}
