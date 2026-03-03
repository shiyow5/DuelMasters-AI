import {
  DECK_GUIDELINES,
  type DeckScore,
} from "@dm-ai/core";
import type { Card } from "@dm-ai/core";
import { getSql } from "@dm-ai/db";
import type { ParsedDeck } from "./parser.js";

/**
 * デッキの評価スコアを算出する
 */
export async function scoreDeck(deck: ParsedDeck): Promise<DeckScore> {
  const warnings: string[] = [];
  const suggestions: string[] = [];

  // カード情報をDBから取得
  const cardInfoMap = await fetchCardInfo(
    deck.entries.map((e) => e.name)
  );

  // 展開済みリスト (各カード × 枚数)
  const expandedCards: Card[] = [];
  for (const entry of deck.entries) {
    const info = cardInfoMap.get(entry.name);
    if (info) {
      for (let i = 0; i < entry.count; i++) {
        expandedCards.push(info);
      }
    }
  }

  // S・トリガー枚数
  const triggerCount = expandedCards.filter((c) => c.is_shield_trigger).length;
  if (triggerCount < DECK_GUIDELINES.triggerCount) {
    warnings.push(
      `S・トリガーが${triggerCount}枚です (推奨: ${DECK_GUIDELINES.triggerCount}枚以上)`
    );
    suggestions.push("S・トリガー持ちのカードを追加して防御力を上げましょう");
  }

  // レインボー枚数
  const rainbowCount = expandedCards.filter((c) => c.is_rainbow).length;
  if (rainbowCount > DECK_GUIDELINES.rainbowMax) {
    warnings.push(
      `多色カードが${rainbowCount}枚です (推奨上限: ${DECK_GUIDELINES.rainbowMax}枚)`
    );
    suggestions.push("多色カードを減らしてマナ置きの柔軟性を確保しましょう");
  }

  // コスト帯配分
  const costCurve = { low: 0, mid: 0, high: 0 };
  for (const card of expandedCards) {
    if (card.cost <= 3) costCurve.low++;
    else if (card.cost <= 6) costCurve.mid++;
    else costCurve.high++;
  }

  if (costCurve.low < 10) {
    warnings.push(
      `低コスト(3以下)が${costCurve.low}枚です (推奨: ${DECK_GUIDELINES.costCurve.low}枚)`
    );
    suggestions.push("初動で使える低コストカードを増やしましょう");
  }

  // 文明比率
  const civilizationBalance: Record<string, number> = {};
  for (const card of expandedCards) {
    for (const civ of card.civilizations) {
      civilizationBalance[civ] = (civilizationBalance[civ] ?? 0) + 1;
    }
  }

  // 色事故リスク判定
  const civCount = Object.keys(civilizationBalance).length;
  if (civCount >= 4) {
    warnings.push(`${civCount}色デッキです。色事故のリスクがあります`);
    suggestions.push("マナ基盤を安定させるために色を絞るか、多色カードを活用しましょう");
  }

  // 初動率 (2-3コストのカード枚数から概算)
  const earlyCards = expandedCards.filter(
    (c) => c.cost >= 2 && c.cost <= 3
  ).length;
  const openingHandRate = calculateOpeningRate(earlyCards, deck.totalCards, 5);

  // 役割バランス
  const roleBalance: Record<string, number> = {};
  for (const card of expandedCards) {
    for (const tag of card.tags) {
      roleBalance[tag] = (roleBalance[tag] ?? 0) + 1;
    }
  }

  if ((roleBalance["受け"] ?? 0) < 4) {
    warnings.push("受け札が少なく、攻撃に弱い構成です");
    suggestions.push("S・トリガーやブロッカーなどの受け札を追加しましょう");
  }

  if ((roleBalance["ドロー"] ?? 0) < 4) {
    suggestions.push("ドローソースを増やしてリソース確保を安定させましょう");
  }

  // 総合スコア (100点満点)
  const overall = calculateOverallScore({
    triggerCount,
    rainbowCount,
    costCurve,
    openingHandRate,
    civCount,
    roleBalance,
    totalCards: deck.totalCards,
  });

  return {
    triggerCount,
    rainbowCount,
    costCurve,
    civilizationBalance,
    openingHandRate,
    roleBalance,
    overall,
    warnings,
    suggestions,
  };
}

/** カード情報をDBから一括取得 */
async function fetchCardInfo(
  names: string[]
): Promise<Map<string, Card>> {
  const map = new Map<string, Card>();

  try {
    const sql = getSql();
    const uniqueNames = [...new Set(names)];

    for (const name of uniqueNames) {
      const rows = await sql`
        SELECT * FROM cards WHERE name = ${name} LIMIT 1
      `;
      if (rows.length > 0) {
        const row = rows[0];
        map.set(name, {
          name: row.name as string,
          civilizations: (row.civilizations ?? []) as Card["civilizations"],
          cost: (row.cost as number) ?? 0,
          type: (row.type ?? "creature") as Card["type"],
          races: (row.races as string[]) ?? [],
          text: (row.text as string) ?? "",
          power: (row.power as number) ?? null,
          is_rainbow: (row.is_rainbow as boolean) ?? false,
          is_shield_trigger: (row.is_shield_trigger as boolean) ?? false,
          tags: ((row.tags as string[]) ?? []) as Card["tags"],
          card_image_url: (row.card_image_url as string) ?? null,
          official_id: (row.official_id as string) ?? null,
          set_code: (row.set_code as string) ?? null,
          rarity: (row.rarity as string) ?? null,
        });
      }
    }
  } catch {
    // DB未接続時は空マップを返す
  }

  return map;
}

/** 初手に特定コスト帯のカードが含まれる確率 (超幾何分布の近似) */
function calculateOpeningRate(
  targetCards: number,
  deckSize: number,
  handSize: number
): number {
  if (deckSize === 0 || targetCards === 0) return 0;
  // P(少なくとも1枚引く) = 1 - P(0枚引く)
  // P(0枚) = C(N-K, n) / C(N, n)
  let pZero = 1;
  for (let i = 0; i < handSize; i++) {
    pZero *= (deckSize - targetCards - i) / (deckSize - i);
  }
  return Math.round((1 - pZero) * 100) / 100;
}

/** 総合スコア計算 */
function calculateOverallScore(params: {
  triggerCount: number;
  rainbowCount: number;
  costCurve: { low: number; mid: number; high: number };
  openingHandRate: number;
  civCount: number;
  roleBalance: Record<string, number>;
  totalCards: number;
}): number {
  let score = 100;

  // 枚数ペナルティ
  if (params.totalCards !== 40) score -= 20;

  // トリガーペナルティ
  if (params.triggerCount < 6) score -= 15;
  else if (params.triggerCount < 8) score -= 5;

  // 多色ペナルティ
  if (params.rainbowCount > 15) score -= 10;

  // コストカーブペナルティ
  if (params.costCurve.low < 10) score -= 10;
  if (params.costCurve.low < 5) score -= 10;

  // 色事故ペナルティ
  if (params.civCount >= 4) score -= 10;
  if (params.civCount >= 5) score -= 5;

  // 初動率ペナルティ
  if (params.openingHandRate < 0.7) score -= 10;

  // 役割バランスペナルティ
  if ((params.roleBalance["受け"] ?? 0) === 0) score -= 15;
  if ((params.roleBalance["フィニッシャー"] ?? 0) === 0) score -= 10;

  return Math.max(0, Math.min(100, score));
}

