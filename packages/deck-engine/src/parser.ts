import type { DeckEntry } from "@dm-ai/core";

export interface ParsedDeck {
  entries: DeckEntry[];
  totalCards: number;
  errors: string[];
}

/**
 * テキスト形式のデッキリストをパースする。
 * 対応フォーマット:
 * - "4 カード名"
 * - "カード名 x4"
 * - "カード名 ×4"
 * - "4x カード名"
 */
export function parseDecklist(text: string): ParsedDeck {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#") && !l.startsWith("//"));

  const entries: DeckEntry[] = [];
  const errors: string[] = [];

  for (const line of lines) {
    const parsed = parseLine(line);
    if (parsed) {
      entries.push(parsed);
    } else {
      errors.push(`パースできない行: "${line}"`);
    }
  }

  const totalCards = entries.reduce((sum, e) => sum + e.count, 0);

  return { entries, totalCards, errors };
}

function parseLine(line: string): DeckEntry | null {
  // パターン1: "4 カード名" or "4x カード名"
  const pattern1 = /^(\d+)\s*[xX×]?\s+(.+)$/;
  const match1 = line.match(pattern1);
  if (match1) {
    return { count: parseInt(match1[1], 10), name: match1[2].trim() };
  }

  // パターン2: "カード名 x4" or "カード名 ×4"
  const pattern2 = /^(.+?)\s*[xX×]\s*(\d+)$/;
  const match2 = line.match(pattern2);
  if (match2) {
    return { count: parseInt(match2[2], 10), name: match2[1].trim() };
  }

  // パターン3: "カード名" (数量なし = 1枚)
  if (line.length > 0 && !/^\d+$/.test(line)) {
    return { count: 1, name: line };
  }

  return null;
}
