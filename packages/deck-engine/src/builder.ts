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
  /** 最低クリーチャー枚数 (既定 DECK_SIZE の 55%)。攻撃役の居ないデッキを避ける。 */
  minCreatures?: number;
}

/** 攻撃役として数えるカード種別の既定比率。速攻でも殴れないデッキにならない下限。 */
const MIN_CREATURE_RATIO = 0.55;

/** クリーチャー系の種別か (進化クリーチャー等も含む)。 */
function isCreatureType(type: string | null | undefined): boolean {
  return typeof type === "string" && type.includes("creature");
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
  // コスト0のカードは通常の40枚デッキに入れられない特殊カードしかない
  // (禁断「新世界王の◯◯」/ 零龍「◯◯の儀」/ FORBIDDEN STAR、および Black Lotus 等の
  //  ジョークカード。いずれも専用ゾーン行きか非公式カードで power も null)。
  // コスト昇順で選ぶとこれらが先頭に来て違法なデッキを組んでしまうため、常に除外する。
  const playableFrag = sql`AND cost >= 1`;

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
    ${excludeFrag} ${civFrag} ${costFrag} ${playableFrag}
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
  const minCreatures = constraints.minCreatures ?? Math.round(DECK_SIZE * MIN_CREATURE_RATIO);
  // 必須カード (手順1で投入済み) の種別は取得していないため、ここでは 0 から数える。
  // 最低枚数を下回る側に倒れるだけなので安全側。
  let creatureCount = 0;

  /** 1枚のカードをデッキへ入れる。入れた枚数を返す (0 なら不採用)。cap で追加枚数を制限できる。 */
  function takeCard(card: Record<string, unknown>, cap = MAX_COPIES): number {
    const name = card.name as string;
    if (usedNames.has(name) || reg.banned.has(name)) return 0;

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
    count = Math.min(count, cap, DECK_SIZE - totalCards);
    if (count <= 0) return 0;

    entries.push({ name, count });
    usedNames.add(name);
    totalCards += count;
    return count;
  }

  // クリーチャーを先に確保する。
  // コストの安い順に無差別へ詰めると、低コスト帯に呪文が多い文明では呪文だらけの
  // 「攻撃役が居ないデッキ」になる (火の速攻テーマでクリーチャー1体という実例が出た)。
  const creatureCards = themeCards.filter((c) => isCreatureType(c.type as string));
  const otherCards = themeCards.filter((c) => !isCreatureType(c.type as string));

  // 1. テーマに合うクリーチャーを最低枚数まで
  for (const card of creatureCards) {
    if (totalCards >= DECK_SIZE || creatureCount >= minCreatures) break;
    creatureCount += takeCard(card, minCreatures - creatureCount);
  }
  // 2. 残り枠に呪文・タマシード等。ただしクリーチャーの最低枠は空けておく。
  // ここで 40 枚まで埋めてしまうと、テーマ検索にクリーチャーが1枚も掛からなかった場合に
  // 手順4のクリーチャー補充が発火せず「殴れないデッキ」がそのまま返る (実際に発生した)。
  const otherLimit = DECK_SIZE - Math.max(0, minCreatures - creatureCount);
  for (const card of otherCards) {
    if (totalCards >= otherLimit) break;
    takeCard(card, otherLimit - totalCards);
  }
  // 3. まだ空きがあればテーマのクリーチャーを追加で
  for (const card of creatureCards) {
    if (totalCards >= DECK_SIZE) break;
    creatureCount += takeCard(card);
  }

  // 4. クリーチャーが最低枚数に届かない場合、テーマ外からでもクリーチャーで補う。
  // (テーマ検索に掛かるクリーチャーが少ない場合でも「殴れないデッキ」を返さないため)
  if (creatureCount < minCreatures && totalCards < DECK_SIZE) {
    const usedList = usedNames.size > 0 ? Array.from(usedNames) : ["__none__"];
    const creatureFillers = await sql`
      SELECT name, cost, type, tags
      FROM cards
      WHERE name NOT IN ${sql(usedList)}
        AND type LIKE ${"%creature%"}
        ${excludeFrag} ${civFrag} ${costFrag} ${playableFrag}
      ORDER BY cost ASC
      LIMIT 20
    `;
    for (const card of creatureFillers) {
      if (totalCards >= DECK_SIZE || creatureCount >= minCreatures) break;
      creatureCount += takeCard(card, minCreatures - creatureCount);
    }
  }

  // 5. 不足分を汎用カード (S・トリガー) で補充
  if (totalCards < DECK_SIZE) {
    const usedList = usedNames.size > 0 ? Array.from(usedNames) : ["__none__"];
    const fillers = await sql`
      SELECT name, cost, type, tags
      FROM cards
      WHERE name NOT IN ${sql(usedList)}
        AND is_shield_trigger = true
        ${excludeFrag} ${civFrag} ${costFrag} ${playableFrag}
      ORDER BY cost ASC
      LIMIT 20
    `;
    for (const filler of fillers) {
      if (totalCards >= DECK_SIZE) break;
      takeCard(filler);
    }
  }

  if (creatureCount < minCreatures) {
    weaknesses.push(
      `クリーチャーが${creatureCount}枚しかありません (推奨 ${minCreatures}枚以上)。攻撃役が不足しています`,
    );
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
