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
