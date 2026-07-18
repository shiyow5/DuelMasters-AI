import { DECK_SIZE, DECK_GUIDELINES, ARCHETYPE_GUIDELINES, type DeckScore } from "@dm-ai/core";
import type { Card, DeckEntry } from "@dm-ai/core";
import { getSql } from "@dm-ai/db";
import type { ParsedDeck } from "./parser.js";
import { isDefensiveCard } from "./tagger.js";
import { inferDeckConcept, inferDeckArchetype, isRelaxedConcept, conceptLabel } from "./concept.js";
import { computeTribalSynergy } from "./synergy.js";

/** scoreDeck 内部のスコアリング閾値 (DECK_GUIDELINES に無い減点基準) */
const HAND_SIZE = 5; // 初手枚数
const OPENING_RATE_TARGET = 0.7; // 初動率の合格ライン
// トリガー目標/大幅不足の閾値はアーキタイプ別 (ARCHETYPE_GUIDELINES) へ移した (#140)。
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

  /**
   * デッキアーキタイプ (#140) とコンセプト (#130)。
   *
   * - **archetype** は採点目標 (S・トリガー/低コストの目安) を選ぶための軸。aggro は受けが薄めなので
   *   トリガー目標を下げ、control/combo は低コスト目標を下げる。**緩める方向のみ** (ARCHETYPE_GUIDELINES)。
   * - **concept** は受け0・フィニッシャー0 等の減点を緩和するかの軸 (combo/control が意図的に絞るため)。
   *
   * 分類器は1本 (inferDeckArchetype が inferDeckConcept を内部再利用)。ここでは両方を採るが、
   * archetype control ⟺ concept control / archetype combo ⟺ concept combo なので relaxed は両者で一致する。
   *
   * **カードが一部しか DB で解決できないデッキでは緩和を信用しない** (Codex 指摘)。
   * 既知の20枚だけから aggro/combo と推定し、未解決の20枚を含む40枚全体のトリガー/受け減点を
   * 緩めてしまうと、採点していない半分を見逃す。**全カードが解決できたときだけ**アーキタイプ/
   * コンセプトで緩和し、そうでなければ unknown 扱い (= 緩めない = 従来の厳しめ採点) にする。
   */
  const fullyResolved = deck.totalCards > 0 && expandedCards.length === deck.totalCards;
  const archetype = fullyResolved ? inferDeckArchetype(expandedCards) : "unknown";
  const guidelines = ARCHETYPE_GUIDELINES[archetype];

  // S・トリガー枚数。目標はアーキタイプ別 (aggro は速度優先で目安が低い)。
  const triggerCount = expandedCards.filter((c) => c.is_shield_trigger).length;
  if (triggerCount < guidelines.triggerCount) {
    warnings.push(`S・トリガーが${triggerCount}枚です (推奨: ${guidelines.triggerCount}枚以上)`);
    suggestions.push("S・トリガー持ちのカードを追加して防御力を上げましょう");
  }

  // レインボー枚数
  const rainbowCount = expandedCards.filter((c) => c.is_rainbow).length;
  if (rainbowCount > DECK_GUIDELINES.rainbowMax) {
    warnings.push(`多色カードが${rainbowCount}枚です (推奨上限: ${DECK_GUIDELINES.rainbowMax}枚)`);
    suggestions.push("多色カードを減らしてマナ置きの柔軟性を確保しましょう");
  }

  // コスト帯配分。低コストの目標もアーキタイプ別 (control/combo は高いカーブを許容する)。
  const costCurve = computeCostCurve(expandedCards);
  if (costCurve.low < guidelines.lowCostMin) {
    warnings.push(`低コスト(3以下)が${costCurve.low}枚です (推奨: ${guidelines.lowCostMin}枚)`);
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
  const earlyCards = expandedCards.filter((c) => c.cost >= 2 && c.cost <= 3).length;
  const openingHandRate = calculateOpeningRate(earlyCards, deck.totalCards, HAND_SIZE);

  /**
   * 役割バランス (#120)。
   *
   * **「タグが未整備」と「その役割のカードが0枚」は違う。**
   *
   * 本番では `cards.tags` が 11563件すべて空だった (ingest-tags が一度も走っていなかった)。
   * `roleBalance["受け"] ?? 0` は未整備でも 0 を返すので、**S・トリガーを20枚積んだデッキに
   * 「受け札が少なく、攻撃に弱い構成です」と警告し、無条件に 25点減点していた**
   * (受け=0 で -15、フィニッシャー=0 で -10)。
   *
   * データが無いなら評価しない。そして**評価していないことを隠さない** (#109 と同じ思想。
   * 黙って警告を消すだけだと「評価済みで問題なし」に見えてしまう)。
   */
  const roleBalance = computeRoleBalance(expandedCards);
  const hasRoleData = expandedCards.some((c) => c.tags.length > 0);
  // カード情報が1枚も引けなかった (DB 未接続 / 全カード未登録)。役割どころか全指標が空。
  const noCardInfo = expandedCards.length === 0 && deck.totalCards > 0;

  /**
   * デッキ全体の戦略コンセプト (#130)。
   *
   * combo/control は受けやフィニッシャーを**意図的に絞る**ことがある。ビートダウン前提の
   * テンプレで一律減点すると、ループ/コントロールのまともなデッキが不当に低スコアになる。
   * `relaxed` のときは該当の減点を軽くし、**軽くしたことを警告で明示する** (黙って消さない)。
   * 確信が無ければ unknown = 現行どおり (緩和しない)。
   *
   * archetype と同じく、**一部しか解決できないデッキでは緩和しない** (既知の半分だけから combo/control と
   * 誤推定して未採点の半分を見逃さないため)。
   */
  const concept = fullyResolved ? inferDeckConcept(expandedCards) : "unknown";
  const relaxed = isRelaxedConcept(concept);

  /**
   * 種族トライバルの軽量シナジー信号 (#141)。**採点は動かさない (情報提供のみ)。**
   * 支配種族が半数以上を占めるときだけ、種族シナジーが期待できる旨を suggestions に添える。
   * どの比率が「強い」かの裏取りができない (デッキリストのコーパスが無い) ので、加点はしない。
   *
   * archetype/concept と同じく、**一部しか解決できないデッキでは信号を出さない** (#141 レビュー)。
   * ratio は解決できた既知カードだけで計算するので、未解決の半分を見ずに「100%トライバル」と
   * 誤報しうる (既知20枚が同種族・残り20枚が未解決 → ratio 1.0)。全解決のときだけ信号を出す。
   */
  const synergy = fullyResolved ? computeTribalSynergy(expandedCards) : null;
  if (synergy) {
    suggestions.push(
      `種族「${synergy.tribe}」が${synergy.count}枚で揃っており、種族シナジーが期待できます`,
    );
  }

  /**
   * **受け札はタグに頼らない。** `is_shield_trigger` はカードの列で、ブロッカー等の
   * キーワードもテキストにある。カード自身の情報だけで判定できるものを、
   * わざわざ別テーブルの派生データ (tags) 経由で見に行くから壊れる。
   */
  const defenseCount = expandedCards.filter(isDefensiveCard).length;
  if (!noCardInfo && defenseCount < MIN_DEFENSE_CARDS) {
    if (relaxed) {
      // 意図的に受けを絞っている可能性を明示する (「攻撃に弱い」と断じない)。
      warnings.push(
        `受け札が${defenseCount}枚と少なめですが、${conceptLabel(concept)}型では意図的な構成の可能性があります`,
      );
    } else {
      warnings.push("受け札が少なく、攻撃に弱い構成です");
      suggestions.push("S・トリガーやブロッカーなどの受け札を追加しましょう");
    }
  }

  if (noCardInfo) {
    // **黙って低いスコアを返さない。** 指標が全部 0 なのは「悪いデッキ」だからではない。
    warnings.push("カード情報を取得できなかったため、この評価は参考値です");
  } else if (!hasRoleData) {
    // ドロー/フィニッシャーはテキストからの推定が要るのでタグに頼らざるを得ない。
    // データが無いなら評価しない。そして**評価していないことを隠さない** (#109 と同じ思想)。
    warnings.push("カードの役割データが未整備のため、ドロー等の役割バランスは評価できていません");
  } else if ((roleBalance["ドロー"] ?? 0) < MIN_DRAW_CARDS) {
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
    hasRoleData,
    defenseCount,
    noCardInfo,
    totalCards: deck.totalCards,
    relaxed,
    triggerFloor: guidelines.triggerCount,
    triggerSevere: guidelines.triggerSevere,
    lowCostMin: guidelines.lowCostMin,
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
    concept,
    archetype,
    synergy,
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
      err instanceof Error ? err.message : err,
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
function calculateOpeningRate(targetCards: number, deckSize: number, handSize: number): number {
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
  /** 役割タグが1枚でも付いているか (#120)。false ならタグ由来の減点をしない。 */
  hasRoleData: boolean;
  /** 受け札の枚数。**タグではなく is_shield_trigger 等から直接数える** (#120)。 */
  defenseCount: number;
  /** カード情報が1枚も引けなかったか。true なら「0枚だから減点」は成り立たない (#120)。 */
  noCardInfo: boolean;
  totalCards: number;
  /**
   * combo/control 型 (#130)。true なら受け0・低コスト極少・フィニッシャー0 の減点を軽くする。
   * これらの要素はコンボ/コントロールでは意図的に絞られるため。**ゼロにはしない**
   * (本当に不足した悪いデッキを見逃さないよう、軽い減点は残す)。
   */
  relaxed: boolean;
  /**
   * アーキタイプ別の S・トリガー/低コスト目標 (#140)。**緩める方向のみ** (ARCHETYPE_GUIDELINES)。
   * aggro はトリガー目標が低く (速度優先)、control/combo は低コスト目標が低い (高カーブ許容)。
   * midrange/unknown は現行と同値なので、これらのデッキのスコアは変わらない (回帰なし)。
   */
  triggerFloor: number;
  triggerSevere: number;
  lowCostMin: number;
}): number {
  let score = 100;

  // 枚数ペナルティ
  if (params.totalCards !== DECK_SIZE) score -= 20;

  // トリガーペナルティ。閾値はアーキタイプ別 (aggro は速攻なので低い目安で許容する)。
  if (params.triggerCount < params.triggerSevere) score -= 15;
  else if (params.triggerCount < params.triggerFloor) score -= 5;

  // 多色ペナルティ
  if (params.rainbowCount > DECK_GUIDELINES.rainbowMax) score -= 10;

  // コストカーブペナルティ。低コストの目標もアーキタイプ別 (control/combo は高いカーブを許容)。
  if (params.costCurve.low < params.lowCostMin) score -= 10;
  // 低コスト「極端に少ない」の追加減点。combo/control は高いカーブを許容するので緩和する。
  if (params.costCurve.low < LOW_COST_SEVERE_THRESHOLD) score -= params.relaxed ? 3 : 10;

  // 色事故ペナルティ
  if (params.civCount >= MULTI_CIV_WARN_THRESHOLD) score -= 10;
  if (params.civCount >= MULTI_CIV_SEVERE_THRESHOLD) score -= 5;

  // 初動率ペナルティ
  if (params.openingHandRate < OPENING_RATE_TARGET) score -= 10;

  // 受け札ゼロの減点。**タグではなくカード自身の情報から数える** (#120)。
  // カード情報がそもそも引けていないなら「0枚」ではない。減点しない。
  // combo/control は受けを意図的に絞ることがあるので緩和する (ただしゼロにはしない)。
  if (!params.noCardInfo && params.defenseCount === 0) score -= params.relaxed ? 5 : 15;
  // フィニッシャーはテキスト推定が要るのでタグ依存。**未整備なら減点しない** (#120)。
  // 未整備を「0枚」と読むと、どんなデッキも無条件に減点される (本番で実際に起きた)。
  // combo/control は勝ち筋が「フィニッシャー」タグに乗らない (ループ/制圧) ことがあるので緩和する。
  // **ただしゼロにはしない** (control は最終的な勝ち手段が要る。誤判定時に雑なデッキを見逃さない)。
  if (params.hasRoleData && (params.roleBalance["フィニッシャー"] ?? 0) === 0) {
    score -= params.relaxed ? 3 : 10;
  }

  return Math.max(0, Math.min(100, score));
}
