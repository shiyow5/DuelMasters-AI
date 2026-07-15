import { TIER_PARAMS, TIER_BELOW } from "./constants.js";

/**
 * aggregateTierData の戻り値要素。
 * interface ではなく type alias にしているのは、postgres.js の sql.json() が要求する
 * JSONValue (インデックスシグネチャを持つ構造) へ代入可能にするため (interface は暗黙の
 * インデックスシグネチャを持たず代入不可になる)。
 */
export type AggregatedTierEntry = {
  tier: string;
  archetype: string;
  /** 使用率 (%)。入賞数 / 母数。**勝率ではない。** */
  usage_rate: number;
  /** このアーキタイプの入賞数。 */
  entries: number;
  /** その期間・そのフォーマットの入賞デッキ総数 (母数)。 */
  total_entries: number;
};

/**
 * **勝率は出せない。**
 *
 * 取込元 (田園補完計画 / デネブログ / ガチまとめ) の記事はどれも「優勝: デッキ名@プレイヤー名」
 * の形式で、**順位しか載っていない**。勝敗も勝率も無い。
 *
 * そもそも CS の入賞データからは原理的に計算できない — **入賞デッキしか分からないので、
 * 負けたデッキの母集団が存在しない**。`usage_rate` (入賞数 / 母数) は**使用率**であって
 * 勝率ではない。
 *
 * 以前は `win_rate: null` / `sample_decklist: null` をハードコードして返しており、
 * UI は常に「--」を表示していた。**出せないものを出せるかのように見せるのはやめる。**
 * 代わりに実データで裏付けられる `entries` / `total_entries` を返す。
 */

/**
 * 大会結果の集計行 (deck_archetype, count) をティアリストに変換する (#132)。
 *
 * 使用率降順に並べ、有意アーキタイプ (使用率 >= noiseFloor かつ 入賞 >= minEntries) を
 * 順位で `count` 段に等分する。ノイズフロア以下は「その他」へ。
 *
 * postgres.js の COUNT は文字列で返るため Number() で数値化する。
 * **呼び出し側のソート順に依存しない** — 内部で使用率降順に整列してから段を割り当てる。
 */
export function aggregateTierData(results: Array<Record<string, unknown>>): AggregatedTierEntry[] {
  const totalEntries = results.reduce((sum, r) => sum + Number(r.count), 0);
  if (totalEntries === 0) return [];

  // 使用率降順。同率は archetype 名で安定ソート (割り当てが呼び出し順に揺れないように)。
  const rows = results
    .map((r) => {
      const entries = Number(r.count);
      return {
        archetype: r.deck_archetype as string,
        entries,
        share: entries / totalEntries,
        usage_rate: Math.round((entries / totalEntries) * 1000) / 10,
      };
    })
    .sort((a, b) => b.share - a.share || (a.archetype < b.archetype ? -1 : 1));

  // ノイズフロア: 単発入賞のロングテールは段に混ぜない。
  const isSignificant = (r: (typeof rows)[number]) =>
    r.share >= TIER_PARAMS.noiseFloor && r.entries >= TIER_PARAMS.minEntries;
  const M = rows.filter(isSignificant).length;

  // rows は使用率降順なので、有意行に出現順で順位を振れば「上位ほど上の Tier」になる。
  let rank = 0;
  return rows.map((r) => {
    let tier: string;
    if (!isSignificant(r)) {
      tier = TIER_BELOW;
    } else {
      const i = rank++;
      tier =
        M <= TIER_PARAMS.count
          ? // 有意が段数以下なら上から連番で埋める (段飛びさせない)。
            `Tier${i + 1}`
          : // 順位で count 段に等分。i=M-1 でも count を超えない。
            `Tier${Math.min(TIER_PARAMS.count, Math.floor((i * TIER_PARAMS.count) / M) + 1)}`;
    }
    return {
      tier,
      archetype: r.archetype,
      usage_rate: r.usage_rate,
      entries: r.entries,
      total_entries: totalEntries,
    };
  });
}
