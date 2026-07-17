import {
  DECK_SIZE,
  MAX_COPIES,
  ROLE_TAGS,
  DECK_GUIDELINES,
  type Format,
  type DeckEntry,
} from "@dm-ai/core";
import { getSql } from "@dm-ai/db";
import { classifyRegulations, applyRegulationToRequired } from "./regulation-rules.js";
import { pickReplacements } from "./suggest.js";
import { deriveStrategy } from "./strategy.js";

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

  // 戦略語 (速攻/コントロール等) を制約へ翻訳し、コア語 (種族・カード名) を検索に使う (#128)。
  const strat = deriveStrategy(theme);
  const searchTheme = strat.core;

  // 制約フィルタ断片 (該当なしは空フラグメント)。
  // civ 判定は jsonb 配列の要素一致 (= ANY)。postgres.js は JS 配列を text[] にバインドする。
  const excludeCards = constraints.excludeCards ?? [];
  const civs = constraints.civilizations ?? [];
  // 最大コスト: ユーザー指定 > 戦略プロファイル (速攻なら 5) > 無制限。
  const maxCost = constraints.maxCost ?? strat.profile?.maxCost;
  // S・トリガーの下限。DECK_GUIDELINES.triggerCount を必ず満たす (コントロールはより厚く)。
  // これで autoBuild の出力が兄弟の scoreDeck を通り、「トリガー/受け札が少ない」の内部矛盾が消える。
  const triggerFloor = Math.max(DECK_GUIDELINES.triggerCount, strat.profile?.triggerFloor ?? 0);
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
      text ILIKE ${"%" + searchTheme + "%"}
      OR name ILIKE ${"%" + searchTheme + "%"}
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(races) r WHERE r ILIKE ${"%" + searchTheme + "%"}
      )
    )
    ${excludeFrag} ${civFrag} ${costFrag} ${playableFrag}
    ORDER BY cost ASC, name ASC, official_id ASC
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

  // 最低クリーチャー枚数: ユーザー指定 > 戦略プロファイルの比率 (速攻 0.65 / コントロール 0.4) > 既定 0.55。
  const minCreatures =
    constraints.minCreatures ??
    Math.round(DECK_SIZE * (strat.profile?.minCreatureRatio ?? MIN_CREATURE_RATIO));

  // 採用済み枚数を名前ごとに持つ。cap 付きで部分的にしか入らなかったカードを
  // 後のパスで上限まで積み増せるようにするため、Set (使用済みフラグ) では足りない。
  const counts = new Map(entries.map((e) => [e.name, e.count]));
  const entryIndex = new Map(entries.map((e, i) => [e.name, i]));

  // 必須カードにクリーチャーが含まれていれば下限に数える。0 から数え直すと、
  // 全部クリーチャーの必須構築でも下限ぶんの枠を余計に予約し、「クリーチャーが0枚」と
  // 誤って警告してしまう。
  let creatureCount = 0;
  if (counts.size > 0) {
    // cards.name に UNIQUE 制約は無く upsert は official_id 単位なので、再録カード (別 official_id・
    // 同名) があると同名で複数行返る。DISTINCT ON で1名1行に絞らないと、採用枚数を行数ぶん
    // 足してしまい (4枚 → 8枚)、クリーチャー補充が発火しなくなる。
    const requiredTypes = await sql`
      SELECT DISTINCT ON (name) name, type
      FROM cards WHERE name IN ${sql(Array.from(counts.keys()))}
      ORDER BY name
    `;
    for (const row of requiredTypes) {
      if (isCreatureType(row.type as string)) creatureCount += counts.get(row.name as string) ?? 0;
    }
  }

  /** 採用済みカード名 (SQL の NOT IN 用。空だと構文エラーになるためダミーを返す)。 */
  function usedList(): string[] {
    return counts.size > 0 ? Array.from(counts.keys()) : ["__none__"];
  }

  /** 殿堂・高コストを踏まえた、そのカードのデッキ内上限枚数。 */
  function copyLimit(card: Record<string, unknown>): number {
    const name = card.name as string;
    if (reg.limited.has(name)) return 1; // 殿堂入りは1枚
    if ((card.cost as number) >= 7) return 2;
    return MAX_COPIES;
  }

  /** カードを最大 want 枚まで入れる。実際に入れた枚数を返す (0 なら不採用)。 */
  function takeCard(card: Record<string, unknown>, want = MAX_COPIES, limit = DECK_SIZE): number {
    const name = card.name as string;
    if (reg.banned.has(name)) return 0;

    const already = counts.get(name) ?? 0;
    let add = Math.min(copyLimit(card) - already, want, limit - totalCards);
    if (add <= 0) return 0;

    // 役割クォータは「上限」であって「門」ではない。残枠のあるタグだけが枚数を抑える。
    // 実際に入れた枚数だけ減らす (以前は clamp 前の枚数で減らしていたため枠を食い潰していた)。
    const tags = (card.tags as string[]) ?? [];
    const tag = tags.find((t) => roleQuotas[t] !== undefined && roleQuotas[t] > 0);
    if (tag !== undefined) {
      add = Math.min(add, roleQuotas[tag]);
      if (add <= 0) return 0;
      roleQuotas[tag] -= add;
    }

    const idx = entryIndex.get(name);
    if (idx === undefined) {
      entries.push({ name, count: add });
      entryIndex.set(name, entries.length - 1);
    } else {
      entries[idx] = { ...entries[idx], count: entries[idx].count + add };
    }
    counts.set(name, already + add);
    totalCards += add;
    return add;
  }

  /**
   * S・トリガーを下限 (triggerFloor) 枚まで保証する (#128 Stage 1)。
   *
   * **なぜ swap が要るか**: step1-6 でテーマのクリーチャー等が 40枚を埋め切ると、step6 の
   * トリガー補充が発火せず、トリガーの少ないデッキがそのまま返る。すると兄弟の `scoreDeck` に
   * 「S・トリガーが少ない/受け札が少ない」と減点される (構築と評価の内部矛盾)。
   *
   * S・トリガーは受け札 (`isDefensiveCard`) の部分集合なので、**トリガーを下限まで満たせば
   * 受け札の下限も自動的に満たす**。判定は `tags` ではなく `is_shield_trigger` 列で行う (#120 の思想)。
   *
   * 40枚のときは「外して良いカード」を1枚抜いてトリガーを差し込む。外して良い =
   * トリガーでない / 必須でない / クリーチャー下限を割らない。トリガー候補が無いプールでは
   * 何もしない (40枚は崩さない)。
   */
  async function ensureTriggerFloor(floor: number): Promise<void> {
    const names = Array.from(counts.keys());
    if (names.length === 0) return;

    // 現在の各カードの属性を1回で引く (再録の同名複数行は DISTINCT ON で1行に)。
    const infoRows = await sql`
      SELECT DISTINCT ON (name) name, cost, type, is_shield_trigger
      FROM cards WHERE name IN ${sql(names)} ORDER BY name
    `;
    const info = new Map(
      infoRows.map((r) => [
        r.name as string,
        {
          cost: (r.cost as number) ?? 0,
          type: (r.type as string) ?? "",
          trigger: (r.is_shield_trigger as boolean) ?? false,
        },
      ]),
    );
    const isTrigger = (name: string) => info.get(name)?.trigger ?? false;
    const countTriggers = () => entries.reduce((s, e) => s + (isTrigger(e.name) ? e.count : 0), 0);

    let triggers = countTriggers();
    if (triggers >= floor) return;

    // 追加候補の S・トリガー (制約順守・コスト昇順)。除外/文明/コスト上限を守る。
    const candRows = await sql`
      SELECT name, cost, type, is_shield_trigger
      FROM cards
      WHERE is_shield_trigger = true
        ${excludeFrag} ${civFrag} ${costFrag} ${playableFrag}
      ORDER BY cost ASC, name ASC, official_id ASC
      LIMIT 60
    `;
    const requiredSet = new Set(constraints.requiredCards ?? []);

    /** 40枚のとき、外して良いカードを1枚減らす。減らせたら true。 */
    function removeOneForSwap(addingName: string): boolean {
      let best: { name: string; cost: number; creature: boolean } | null = null;
      for (const e of entries) {
        if (e.name === addingName) continue;
        if (requiredSet.has(e.name)) continue;
        if (isTrigger(e.name)) continue;
        const meta = info.get(e.name);
        const creature = isCreatureType(meta?.type);
        // 攻撃役の下限を割るクリーチャーは外さない。
        if (creature && creatureCount <= minCreatures) continue;
        const cost = meta?.cost ?? 0;
        // 非クリーチャー優先 → 高コスト優先 (最も余剰なフィラーから抜く)。
        const better = best === null || (creature === best.creature ? cost > best.cost : !creature);
        if (better) best = { name: e.name, cost, creature };
      }
      if (best === null) return false;
      const idx = entries.findIndex((e) => e.name === best!.name);
      const e = entries[idx];
      entries[idx] = { ...e, count: e.count - 1 };
      // counts は entries と同期している。entries 側の真の値から引く (?? フォールバックに頼らない)。
      counts.set(e.name, e.count - 1);
      if (best.creature) creatureCount -= 1;
      totalCards -= 1;
      if (entries[idx].count <= 0) entries.splice(idx, 1);
      return true;
    }

    /** トリガーを1枚差し込む (roleQuota は下限優先で無視する)。 */
    function addOneTrigger(card: Record<string, unknown>): void {
      const name = card.name as string;
      const idx = entries.findIndex((e) => e.name === name);
      if (idx === -1) entries.push({ name, count: 1 });
      else entries[idx] = { ...entries[idx], count: entries[idx].count + 1 };
      counts.set(name, (counts.get(name) ?? 0) + 1);
      if (!info.has(name)) {
        info.set(name, {
          cost: (card.cost as number) ?? 0,
          type: (card.type as string) ?? "",
          trigger: true,
        });
      }
      if (isCreatureType(card.type as string)) creatureCount += 1;
      totalCards += 1;
      triggers += 1;
    }

    for (const cand of candRows) {
      if (triggers >= floor) break;
      const name = cand.name as string;
      if (reg.banned.has(name)) continue;
      const room = copyLimit(cand) - (counts.get(name) ?? 0);
      for (let k = 0; k < room && triggers < floor; k++) {
        // 40枚なら1枚空けてから差す。空けられなければこれ以上は無理。
        if (totalCards >= DECK_SIZE && !removeOneForSwap(name)) return;
        addOneTrigger(cand);
      }
    }
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
    takeCard(card, MAX_COPIES, otherLimit);
  }
  // 3. まだ空きがあればテーマのクリーチャーを追加で (手順1で上限未満だったカードの積み増しも兼ねる)
  for (const card of creatureCards) {
    if (totalCards >= DECK_SIZE) break;
    creatureCount += takeCard(card);
  }

  // 4. クリーチャーが最低枚数に届かない場合、テーマ外からでもクリーチャーで補う。
  // (テーマ検索に掛かるクリーチャーが少ない場合でも「殴れないデッキ」を返さないため)
  if (creatureCount < minCreatures && totalCards < DECK_SIZE) {
    const creatureFillers = await sql`
      SELECT name, cost, type, tags
      FROM cards
      WHERE name NOT IN ${sql(usedList())}
        AND type LIKE ${"%creature%"}
        ${excludeFrag} ${civFrag} ${costFrag} ${playableFrag}
      ORDER BY cost ASC, name ASC, official_id ASC
      LIMIT 20
    `;
    for (const card of creatureFillers) {
      if (totalCards >= DECK_SIZE || creatureCount >= minCreatures) break;
      creatureCount += takeCard(card, minCreatures - creatureCount);
    }
  }

  // 5. クリーチャーを最低枚数まで確保できなかった場合、手順2で予約した枠が浮いている。
  // そのまま返すと 40 枚に満たない違法なデッキになるため、テーマの非クリーチャーで埋め戻す。
  for (const card of otherCards) {
    if (totalCards >= DECK_SIZE) break;
    takeCard(card);
  }

  // 6. 不足分を汎用カード (S・トリガー) で補充
  if (totalCards < DECK_SIZE) {
    const fillers = await sql`
      SELECT name, cost, type, tags
      FROM cards
      WHERE name NOT IN ${sql(usedList())}
        AND is_shield_trigger = true
        ${excludeFrag} ${civFrag} ${costFrag} ${playableFrag}
      ORDER BY cost ASC, name ASC, official_id ASC
      LIMIT 20
    `;
    for (const filler of fillers) {
      if (totalCards >= DECK_SIZE) break;
      takeCard(filler);
    }
  }

  // 7. S・トリガーを下限まで保証する (構築↔評価の内部整合。#128)。
  await ensureTriggerFloor(triggerFloor);

  if (creatureCount < minCreatures) {
    weaknesses.push(
      `クリーチャーが${creatureCount}枚しかありません (推奨 ${minCreatures}枚以上)。攻撃役が不足しています`,
    );
  }

  const strategy = strat.profile
    ? `「${theme}」= ${strat.profile.label} の構築です。`
    : `「${theme}」をテーマとした構築です。`;

  return {
    entries,
    totalCards,
    strategy,
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
          ORDER BY cost ASC, name ASC, official_id ASC LIMIT 5`
      : await sql`
          SELECT name, cost, tags FROM cards
          WHERE text ILIKE ${"%" + goal + "%"}
            AND name NOT IN ${sql(notInDeck)}
          ORDER BY cost ASC, name ASC, official_id ASC LIMIT 5`;
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
