import { DECK_SIZE, MAX_COPIES, ROLE_TAGS, type Format, type DeckEntry } from "@dm-ai/core";
import { getSql } from "@dm-ai/db";
import { classifyRegulations, applyRegulationToRequired } from "./regulation-rules.js";
import { pickReplacements } from "./suggest.js";

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
  constraints: BuildConstraints = {},
): Promise<BuildResult> {
  const sql = getSql();
  const entries: DeckEntry[] = [];
  let totalCards = 0;
  const weaknesses: string[] = [];

  // 殿堂レギュレーションを取得・分類
  const regRows = await sql`
    SELECT card_name, restriction_type FROM regulations WHERE format = ${format}
  `;
  const reg = classifyRegulations(
    regRows.map((r) => ({
      card_name: r.card_name as string,
      restriction_type: r.restriction_type as string,
    })),
  );

  // 制約フィルタ断片 (該当なしは空フラグメント)。
  // civ 判定は jsonb 配列の要素一致 (= ANY)。postgres.js は JS 配列を text[] にバインドする。
  const excludeCards = constraints.excludeCards ?? [];
  const civs = constraints.civilizations ?? [];
  const maxCost = constraints.maxCost;
  const excludeFrag = excludeCards.length > 0 ? sql`AND name NOT IN ${sql(excludeCards)}` : sql``;
  const civFrag =
    civs.length > 0
      ? sql`AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(civilizations) c WHERE c = ANY(${sql.array(civs)}))`
      : sql``;
  const costFrag = maxCost !== undefined ? sql`AND cost <= ${maxCost}` : sql``;

  // 1. 必須カード追加 (殿堂制約を適用)
  if (constraints.requiredCards && constraints.requiredCards.length > 0) {
    const { adopted, warnings } = applyRegulationToRequired(constraints.requiredCards, reg);
    for (const a of adopted) {
      entries.push(a);
      totalCards += a.count;
    }
    weaknesses.push(...warnings);
  }

  // 2. テーマに関連するカードを検索
  const themeCards = await sql`
    SELECT name, cost, type, tags, civilizations, is_shield_trigger, is_rainbow
    FROM cards
    WHERE (
      text ILIKE ${"%" + theme + "%"}
      OR name ILIKE ${"%" + theme + "%"}
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(races) r WHERE r ILIKE ${"%" + theme + "%"}
      )
    )
    ${excludeFrag} ${civFrag} ${costFrag}
    ORDER BY cost ASC
    LIMIT 100
  `;

  // 3. 役割ごとにカードを選定
  const roleQuotas: Record<string, number> = {
    初動: 12,
    フィニッシャー: 4,
    受け: 8,
    除去: 4,
    ドロー: 4,
    ブースト: 4,
  };

  const usedNames = new Set(entries.map((e) => e.name));

  for (const card of themeCards) {
    if (totalCards >= DECK_SIZE) break;
    const name = card.name as string;
    if (usedNames.has(name) || reg.banned.has(name)) continue;

    const tags = (card.tags as string[]) ?? [];
    const cost = card.cost as number;

    let count = MAX_COPIES;
    for (const tag of tags) {
      if (roleQuotas[tag] !== undefined && roleQuotas[tag] > 0) {
        count = Math.min(count, roleQuotas[tag]);
        roleQuotas[tag] -= count;
        break;
      }
    }

    if (cost >= 7) count = Math.min(count, 2);
    if (reg.limited.has(name)) count = Math.min(count, 1); // 殿堂入りは1枚
    if (totalCards + count > DECK_SIZE) count = DECK_SIZE - totalCards;
    if (count <= 0) continue;

    entries.push({ name, count });
    usedNames.add(name);
    totalCards += count;
  }

  // 4. 不足分を汎用カード (S・トリガー) で補充
  if (totalCards < DECK_SIZE) {
    const usedList = Array.from(usedNames).length > 0 ? Array.from(usedNames) : ["__none__"];
    const fillers = await sql`
      SELECT name, cost, tags
      FROM cards
      WHERE name NOT IN ${sql(usedList)}
        AND is_shield_trigger = true
        ${excludeFrag} ${civFrag} ${costFrag}
      ORDER BY cost ASC
      LIMIT 20
    `;

    for (const filler of fillers) {
      if (totalCards >= DECK_SIZE) break;
      const name = filler.name as string;
      if (usedNames.has(name) || reg.banned.has(name)) continue;
      let count = Math.min(MAX_COPIES, DECK_SIZE - totalCards);
      if (reg.limited.has(name)) count = Math.min(count, 1);
      if (count <= 0) continue;
      entries.push({ name, count });
      usedNames.add(name);
      totalCards += count;
    }
  }

  return {
    entries,
    totalCards,
    strategy: `「${theme}」をテーマとした構築です。`,
    weaknesses: [...weaknesses, ...analyzeWeaknesses(entries)],
    alternatives: [],
  };
}

function analyzeWeaknesses(entries: DeckEntry[]): string[] {
  const weaknesses: string[] = [];
  const total = entries.reduce((s, e) => s + e.count, 0);
  if (total < DECK_SIZE) weaknesses.push(`カードが${total}枚しかありません (${DECK_SIZE}枚必要)`);
  return weaknesses;
}

/**
 * デッキの改善提案を生成する。
 * 「何を抜いて何を入れるか」を決定的に返す (純粋ロジックは suggest.ts)。
 */
export async function suggestReplacements(
  entries: DeckEntry[],
  goals: string[],
): Promise<Array<{ original: string; replacement: string; reason: string }>> {
  if (entries.length === 0 || goals.length === 0) return [];
  const sql = getSql();

  const deckNames = entries.map((e) => e.name);
  const notInDeck = deckNames.length > 0 ? deckNames : ["__none__"];

  // デッキ内カードの情報を一括取得
  const rows = await sql`
    SELECT name, cost, tags FROM cards WHERE name IN ${sql(deckNames)}
  `;
  const infoByName = new Map(
    rows.map((r) => [
      r.name as string,
      { cost: (r.cost as number) ?? 0, tags: (r.tags as string[]) ?? [] },
    ]),
  );
  const deckCards = entries.map((e) => {
    const info = infoByName.get(e.name);
    return {
      name: e.name,
      count: e.count,
      cost: info?.cost ?? 0,
      tags: info?.tags ?? [],
    };
  });

  // goal ごとに候補を検索 (ROLE_TAGS はタグ一致、自由語は text ILIKE)
  const isRoleTag = (g: string) => (ROLE_TAGS as readonly string[]).includes(g);
  const candidatesByGoal = new Map<string, Array<{ name: string; cost: number; tags: string[] }>>();
  for (const goal of goals) {
    const candRows = isRoleTag(goal)
      ? await sql`
          SELECT name, cost, tags FROM cards
          WHERE EXISTS (SELECT 1 FROM jsonb_array_elements_text(tags) t WHERE t = ${goal})
            AND name NOT IN ${sql(notInDeck)}
          ORDER BY cost ASC LIMIT 5`
      : await sql`
          SELECT name, cost, tags FROM cards
          WHERE text ILIKE ${"%" + goal + "%"}
            AND name NOT IN ${sql(notInDeck)}
          ORDER BY cost ASC LIMIT 5`;
    candidatesByGoal.set(
      goal,
      candRows.map((r) => ({
        name: r.name as string,
        cost: (r.cost as number) ?? 0,
        tags: (r.tags as string[]) ?? [],
      })),
    );
  }

  return pickReplacements({ deckCards, candidatesByGoal });
}
