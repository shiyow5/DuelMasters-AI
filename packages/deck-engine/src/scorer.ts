import { DECK_SIZE, DECK_GUIDELINES, type DeckScore } from "@dm-ai/core";
import type { Card, DeckEntry } from "@dm-ai/core";
import { getSql } from "@dm-ai/db";
import type { ParsedDeck } from "./parser.js";

/** scoreDeck 内部のスコアリング閾値 (DECK_GUIDELINES に無い減点基準) */
const HAND_SIZE = 5; // 初手枚数
const OPENING_RATE_TARGET = 0.7; // 初動率の合格ライン
const TRIGGER_SEVERE_THRESHOLD = 6; // トリガー大幅不足の閾値
const LOW_COST_SEVERE_THRESHOLD = 5; // 低コスト大幅不足の閾値
const MULTI_CIV_WARN_THRESHOLD = 4; // 色事故警告の文明数
const MULTI_CIV_SEVERE_THRESHOLD = 5; // 色事故追加減点の文明数
const MIN_DEFENSE_CARDS = 4; // 受け札の最低目安
const MIN_DRAW_CARDS = 4; // ドロー札の最低目安

/**
 * デッキの評価スコアを算出する
 */
export async function scoreDeck(deck: ParsedDeck): Promise<DeckScore> {
  const warnings: string[] = [];
  const suggestions: string[] = [];

  // カード情報をDBから取得 → 各カード × 枚数に展開
  const cardInfoMap = await fetchCardInfo(deck.entries.map((e) => e.name));
  const expandedCards = expandCards(deck.entries, cardInfoMap);

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
  const costCurve = computeCostCurve(expandedCards);
  if (costCurve.low < DECK_GUIDELINES.costCurve.low) {
    warnings.push(
      `低コスト(3以下)が${costCurve.low}枚です (推奨: ${DECK_GUIDELINES.costCurve.low}枚)`
    );
    suggestions.push("初動で使える低コストカードを増やしましょう");
  }

  // 文明比率
  const civilizationBalance = computeCivilizationBalance(expandedCards);
  const civCount = Object.keys(civilizationBalance).length;
  if (civCount >= MULTI_CIV_WARN_THRESHOLD) {
    warnings.push(`${civCount}色デッキです。色事故のリスクがあります`);
    suggestions.push("マナ基盤を安定させるために色を絞るか、多色カードを活用しましょう");
  }

  // 初動率 (2-3コストのカード枚数から概算)
  const earlyCards = expandedCards.filter(
    (c) => c.cost >= 2 && c.cost <= 3
  ).length;
  const openingHandRate = calculateOpeningRate(
    earlyCards,
    deck.totalCards,
    HAND_SIZE
  );

  // 役割バランス
  const roleBalance = computeRoleBalance(expandedCards);
  if ((roleBalance["受け"] ?? 0) < MIN_DEFENSE_CARDS) {
    warnings.push("受け札が少なく、攻撃に弱い構成です");
    suggestions.push("S・トリガーやブロッカーなどの受け札を追加しましょう");
  }

  if ((roleBalance["ドロー"] ?? 0) < MIN_DRAW_CARDS) {
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

/** DB行 → Card 変換 */
function rowToCard(row: Record<string, unknown>): Card {
  return {
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
  };
}

/** カード情報をDBから一括取得 */
async function fetchCardInfo(names: string[]): Promise<Map<string, Card>> {
  const map = new Map<string, Card>();
  const uniqueNames = [...new Set(names)];
  if (uniqueNames.length === 0) return map;

  try {
    const sql = getSql();
    const rows = await sql`
      SELECT * FROM cards WHERE name IN ${sql(uniqueNames)}
    `;
    for (const row of rows) {
      const name = row.name as string;
      if (map.has(name)) continue; // 同名複数行は最初の1行を採用 (変更前の LIMIT 1 相当)
      map.set(name, rowToCard(row));
    }
  } catch (err) {
    // DB未接続時はカード情報なしで評価を続行する (劣化動作は仕様として維持)
    console.warn(
      "カード情報の取得に失敗したため、カード情報なしで評価します:",
      err instanceof Error ? err.message : err
    );
  }

  return map;
}

/** デッキエントリをカード情報で展開 (カード × 枚数) */
function expandCards(entries: DeckEntry[], cardInfo: Map<string, Card>): Card[] {
  const expanded: Card[] = [];
  for (const entry of entries) {
    const info = cardInfo.get(entry.name);
    if (info) {
      for (let i = 0; i < entry.count; i++) {
        expanded.push(info);
      }
    }
  }
  return expanded;
}

/** コストカーブ集計 */
function computeCostCurve(cards: Card[]): {
  low: number;
  mid: number;
  high: number;
} {
  const costCurve = { low: 0, mid: 0, high: 0 };
  for (const card of cards) {
    if (card.cost <= 3) costCurve.low++;
    else if (card.cost <= 6) costCurve.mid++;
    else costCurve.high++;
  }
  return costCurve;
}

/** 文明比率集計 */
function computeCivilizationBalance(cards: Card[]): Record<string, number> {
  const balance: Record<string, number> = {};
  for (const card of cards) {
    for (const civ of card.civilizations) {
      balance[civ] = (balance[civ] ?? 0) + 1;
    }
  }
  return balance;
}

/** 役割タグ集計 */
function computeRoleBalance(cards: Card[]): Record<string, number> {
  const balance: Record<string, number> = {};
  for (const card of cards) {
    for (const tag of card.tags) {
      balance[tag] = (balance[tag] ?? 0) + 1;
    }
  }
  return balance;
}

/** 初手に特定コスト帯のカードが含まれる確率 (超幾何分布の近似) */
function calculateOpeningRate(
  targetCards: number,
  deckSize: number,
  handSize: number
): number {
  if (deckSize <= 0 || targetCards <= 0) return 0;
  // 山札が初手枚数以下だと超幾何分布が定義できない(分母0で NaN)。
  // 対象カードが1枚でもあれば必ず引ける扱いとする。
  if (deckSize <= handSize) return 1;
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
  if (params.totalCards !== DECK_SIZE) score -= 20;

  // トリガーペナルティ
  if (params.triggerCount < TRIGGER_SEVERE_THRESHOLD) score -= 15;
  else if (params.triggerCount < DECK_GUIDELINES.triggerCount) score -= 5;

  // 多色ペナルティ
  if (params.rainbowCount > DECK_GUIDELINES.rainbowMax) score -= 10;

  // コストカーブペナルティ
  if (params.costCurve.low < DECK_GUIDELINES.costCurve.low) score -= 10;
  if (params.costCurve.low < LOW_COST_SEVERE_THRESHOLD) score -= 10;

  // 色事故ペナルティ
  if (params.civCount >= MULTI_CIV_WARN_THRESHOLD) score -= 10;
  if (params.civCount >= MULTI_CIV_SEVERE_THRESHOLD) score -= 5;

  // 初動率ペナルティ
  if (params.openingHandRate < OPENING_RATE_TARGET) score -= 10;

  // 役割バランスペナルティ
  if ((params.roleBalance["受け"] ?? 0) === 0) score -= 15;
  if ((params.roleBalance["フィニッシャー"] ?? 0) === 0) score -= 10;

  return Math.max(0, Math.min(100, score));
}
