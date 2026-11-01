import type { DeckEntry } from "@dm-ai/core";

/**
 * レギュレーション照合用のカード名キー (B-02)。
 *
 * 殿堂チェックはカード名の**完全一致**だったため、中黒の有無・全角/半角・囲み記号・空白の
 * ゆれだけでプレミアム殿堂/殿堂入りをすり抜けていた。
 * agent の `normalizeCardName` (packages/agent/src/card-search.ts, #111) と**同じ正規化**にする。
 * deck-engine は agent に依存しないので複製している。片方を変えたらもう片方も揃えること。
 */
export function regulationNameKey(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[・･]/g, "")
    .replace(/[《》≪≫«»『』【】「」\s]/g, "");
}

/** 正規化キーごとに合算したデッキの1カード分 */
export interface MergedEntry {
  /** 表示用の名前 (最初に出てきた行の表記) */
  name: string;
  /** 同じカードの全行の合計枚数 */
  count: number;
}

/**
 * 同じカードを複数行に分けて書いても1枚として数えられるよう、正規化キーで合算する (B-03)。
 * 並びは最初に出てきた順。
 */
export function mergeEntriesByName(entries: readonly DeckEntry[]): Map<string, MergedEntry> {
  const merged = new Map<string, MergedEntry>();
  for (const entry of entries) {
    const key = regulationNameKey(entry.name);
    const prev = merged.get(key);
    if (prev) {
      prev.count += entry.count;
    } else {
      merged.set(key, { name: entry.name, count: entry.count });
    }
  }
  return merged;
}
