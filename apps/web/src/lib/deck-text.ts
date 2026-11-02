/** 保存済みデッキの1行。超次元・GR の行は zone 付きで保存される (メインは zone 無し)。QA② */
export interface SavedDeckCard {
  name: string;
  count: number;
  zone?: "hyperspatial" | "gr";
}

const ZONE_HEADINGS = { hyperspatial: "超次元ゾーン", gr: "GRゾーン" } as const;

/**
 * 保存済みのカード配列を、入力欄に戻すデッキリストの文字列にする。
 *
 * メインは見出し無しで先に並べ、超次元・GR があればそれぞれ見出しを付けて後ろに置く
 * (deck-engine の parser が見出しでゾーンを分けるので、評価し直しても同じ形に戻る)。
 */
export function savedCardsToDecklist(cards: readonly SavedDeckCard[]): string {
  const line = (c: SavedDeckCard) => `${c.count} ${c.name}`;
  const lines = cards.filter((c) => !c.zone).map(line);
  for (const zone of ["hyperspatial", "gr"] as const) {
    const inZone = cards.filter((c) => c.zone === zone);
    if (inZone.length > 0) lines.push(ZONE_HEADINGS[zone], ...inZone.map(line));
  }
  return lines.join("\n");
}

/*
 * 入力欄の枚数カウンタ用 (#179 / #165 B-05・B-07)。
 * **deck-engine の parser.ts (detectZoneHeading / parseLine) と同じ規則にすること。**
 * web は deck-engine に依存しない (DB 依存を持ち込まない) ため、カウンタに要る部分だけを写している。
 * 正しい枚数の判定は API (/api/deck/evaluate) 側で行う。ここは入力中の目安。
 */
type CounterZone = "main" | "hyperspatial" | "gr";

function headingZone(line: string): CounterZone | null {
  const t = line
    .normalize("NFKC")
    .replace(/^[\s【\[(<〈《「『■□◆◇●○▼▽▶・*=\-]+/u, "")
    .replace(/[\s】\])>〉》」』:]+$/u, "")
    .replace(/[\s(:]*[xX×]?\d+\s*枚?\s*\)?$/u, "")
    .replace(/[\s】\])>〉》」』:]+$/u, "")
    .replace(/\s+/g, "")
    .toLowerCase();
  if (/^(メイン(デッキ)?|デッキ(リスト)?|maindeck|main)$/.test(t)) return "main";
  if (/^(超次元(ゾーン)?|hyperspatial(zone)?)$/.test(t)) return "hyperspatial";
  if (/^(超?gr(ゾーン|zone)?)$/.test(t)) return "gr";
  return null;
}

const COUNT = "([0-9０-９]+)";
const SEP = "[xX×✕ｘＸ*＊]";
const COUNT_PATTERNS: Array<{ re: RegExp; group: number }> = [
  { re: new RegExp(`^${COUNT}\\s*枚?\\s*${SEP}?\\s+.+$`, "u"), group: 1 },
  { re: new RegExp(`^.+?\\s*${SEP}\\s*${COUNT}\\s*枚?$`, "u"), group: 1 },
  { re: new RegExp(`^.+?\\s*${COUNT}\\s*枚$`, "u"), group: 1 },
];

/** 1行の枚数。数字だけの行 (parser では読めない行) は 0 */
function lineCount(line: string): number {
  for (const { re, group } of COUNT_PATTERNS) {
    const m = line.match(re);
    if (m) return parseInt(m[group].normalize("NFKC"), 10);
  }
  return /^[0-9０-９]+$/.test(line) ? 0 : 1;
}

/**
 * デッキリストのメインデッキの枚数。見出しは数えず、超次元・GR の下の行はメインに入れない。
 * 枚数の書いていない行は1枚 (parser と同じ)。
 */
export function countMainCards(decklist: string): number {
  let zone: CounterZone = "main";
  let total = 0;
  for (const raw of decklist.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith("//")) continue;
    const heading = headingZone(line);
    if (heading) {
      zone = heading;
      continue;
    }
    if (zone === "main") total += lineCount(line);
  }
  return total;
}
