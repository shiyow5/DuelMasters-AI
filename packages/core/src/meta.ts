import { TIER_THRESHOLDS } from "./constants.js";

/** aggregateTierData の戻り値要素 */
export interface AggregatedTierEntry {
  tier: string;
  archetype: string;
  usage_rate: number;
  win_rate: null;
  sample_decklist: null;
}

/**
 * 大会結果の集計行 (deck_archetype, count) をティアリストに変換する。
 * postgres.js の COUNT は文字列で返るため Number() で数値化する。
 */
export function aggregateTierData(
  results: Array<Record<string, unknown>>
): AggregatedTierEntry[] {
  const totalEntries = results.reduce((sum, r) => sum + Number(r.count), 0);
  return results.map((r) => {
    const usageRate = Number(r.count) / totalEntries;
    const tier =
      usageRate >= TIER_THRESHOLDS.tier1
        ? "Tier1"
        : usageRate >= TIER_THRESHOLDS.tier2
          ? "Tier2"
          : "Tier3";
    return {
      tier,
      archetype: r.deck_archetype as string,
      usage_rate: Math.round(usageRate * 1000) / 10,
      win_rate: null,
      sample_decklist: null,
    };
  });
}
