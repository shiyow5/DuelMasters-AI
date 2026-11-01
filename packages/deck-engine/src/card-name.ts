import { cardNameKey, type DeckEntry } from "@dm-ai/core";

/**
 * レギュレーション照合用のカード名キー (B-02 / #167)。
 *
 * 殿堂チェックはカード名の**完全一致**だったため、中黒の有無・全角/半角・囲み記号・空白・
 * 引用符のゆれだけでプレミアム殿堂/殿堂入りをすり抜けていた。
 * agent の `normalizeCardName` と同じく `@dm-ai/core` の `cardNameKey` を使う
 * (以前は2か所に同じ式を複製していたが、ドリフトしないよう core に一本化した)。
 */
export function regulationNameKey(name: string): string {
  return cardNameKey(name);
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

/**
 * ツインパクトの片面名キー (#167 優先2)。
 *
 * ツインパクトは `A / B` と2つの名前を持つ。正規化キー ({@link regulationNameKey}) では
 * 空白が落ち、全角 `／` は NFKC で `/` になるので、区切りの表記ゆれ
 * (`A / B` `A/B` `A／B` `A　／　B`) はどれも `a/b` に揃う。それを `/` で分ける。
 *
 * **ちょうど2つに分かれ、両方が空でないときだけ**片面として扱う。
 * `/` を含まない名前・`/` が2つ以上ある名前・片側が空の名前は分けない (空配列)。
 */
export function twinpactSideKeys(key: string): string[] {
  const parts = key.split("/");
  if (parts.length !== 2) return [];
  const [a, b] = parts as [string, string];
  if (a === "" || b === "") return [];
  return [a, b];
}
