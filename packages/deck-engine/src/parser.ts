import type { DeckEntry } from "@dm-ai/core";

/** デッキリストの区分。メイン以外は40枚判定に入れない (QA② / #165 B-07) */
export type DeckZone = "main" | "hyperspatial" | "gr";

/** メイン以外のゾーンのカード */
export interface ExtraZones {
  /** 超次元ゾーン */
  hyperspatial: DeckEntry[];
  /** GRゾーン */
  gr: DeckEntry[];
}

export interface ParsedDeck {
  /** メインデッキのカード (見出しより前の行と「メインデッキ」見出しの下) */
  entries: DeckEntry[];
  /** メインデッキの合計枚数。超次元・GR は含まない */
  totalCards: number;
  errors: string[];
  /**
   * 超次元・GR ゾーンのカード。parseDecklist は常に入れる。
   * autoBuild の結果など、ゾーンを持たないデッキから組み立てるときは省略してよい (= どちらも空)。
   */
  zones?: ExtraZones;
}

/**
 * 区分見出しの行ならそのゾーンを返す。見出しでなければ null。
 *
 * デッキサイトからコピーしたリストの書き方を広めに受ける:
 * `メインデッキ` `【超次元ゾーン】` `■GRゾーン (12枚)` `超GR：12` `ＧＲゾーン` など。
 * 前後の記号と末尾の枚数表記を落としてから、見出しの語と**完全一致**で判定する
 * (「超次元ミカド・ホール」のようなカード名を見出しと取り違えないため)。
 */
export function detectZoneHeading(line: string): DeckZone | null {
  const t = line
    .normalize("NFKC")
    .replace(/^[\s【\[(<〈《「『■□◆◇●○▼▽▶・*=\-]+/u, "")
    .replace(/[\s】\])>〉》」』:]+$/u, "")
    // 末尾の枚数表記: "(40枚)" "40枚" ": 8" "x12"
    .replace(/[\s(:]*[xX×]?\d+\s*枚?\s*\)?$/u, "")
    .replace(/[\s】\])>〉》」』:]+$/u, "")
    .replace(/\s+/g, "")
    .toLowerCase();
  if (/^(メイン(デッキ)?|デッキ(リスト)?|maindeck|main)$/.test(t)) return "main";
  if (/^(超次元(ゾーン)?|hyperspatial(zone)?)$/.test(t)) return "hyperspatial";
  if (/^(超?gr(ゾーン|zone)?)$/.test(t)) return "gr";
  return null;
}

/**
 * テキスト形式のデッキリストをパースする。
 * 対応フォーマット:
 * - "4 カード名"
 * - "カード名 x4"
 * - "カード名 ×4"
 * - "4x カード名"
 *
 * 区分見出し (`メインデッキ` / `超次元ゾーン` / `GRゾーン` など) は**カードとして数えず**、
 * 以降の行をそのゾーンに入れる。見出しより前の行はメインデッキ扱い。
 */
export function parseDecklist(text: string): ParsedDeck {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#") && !l.startsWith("//"));

  const byZone: Record<DeckZone, DeckEntry[]> = { main: [], hyperspatial: [], gr: [] };
  const errors: string[] = [];
  let zone: DeckZone = "main";

  for (const line of lines) {
    const heading = detectZoneHeading(line);
    if (heading) {
      zone = heading;
      continue;
    }
    const parsed = parseLine(line);
    if (parsed) {
      byZone[zone].push(parsed);
    } else {
      errors.push(`パースできない行: "${line}"`);
    }
  }

  const entries = byZone.main;
  const totalCards = entries.reduce((sum, e) => sum + e.count, 0);

  return {
    entries,
    totalCards,
    errors,
    zones: { hyperspatial: byZone.hyperspatial, gr: byZone.gr },
  };
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
