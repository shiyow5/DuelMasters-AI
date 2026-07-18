import type { Card } from "@dm-ai/core";

/**
 * 軽量シナジー信号 (#141 Stage 3 スライス1)。
 *
 * デュエル・マスターズは種族トライバルが強い (本番 cards 実測: ジョーカーズ 505枚 / ハンター 394枚 /
 * アーマード・ドラゴン 361枚 …)。デッキが特定種族で揃っていれば種族シナジー (種族参照の強化・
 * サーチ等) が期待できる。ここではその「支配的な種族と厚み」を粗く測る**信号**を返す。
 *
 * **採点は動かさない (情報提供のみ)。** どの種族比率が「強い」かはデッキリストのコーパスが無いと
 * 裏取りできない (#126 の結論)。ここで得た信号を減点/加点に使うと、まさに #130/#137 で潰した
 * 「データ無しの過剰チューニング」を繰り返す。まずは支配種族を surface するに留め、構築のトライバル
 * 寄せ・採点への重み付けは実データが揃ってから (フォローアップ)。
 */

export interface TribalSynergy {
  /** 支配的な種族。 */
  tribe: string;
  /** その種族を持つカードの枚数。 */
  count: number;
  /** count / 総枚数 (0-1)。 */
  ratio: number;
}

/** これ未満のカード数では信号の材料が足りない (パースだけで展開できていない等)。 */
const MIN_CARDS = 20;
/**
 * 支配種族と認める最低比率。**半数以上 (>= 0.5)** を要求する (ちょうど 0.5 も支配種族とみなす)。
 *
 * これ未満は「種族がバラけている = トライバルではない」と判断して null を返す。競技的な
 * トライバルデッキは中心種族が概ね半数以上を占める、という経験則に基づく (ヒューリスティック)。
 */
const TRIBAL_RATIO = 0.5;

/**
 * デッキの支配的な種族シナジー信号を返す。純粋関数。
 *
 * 各カードは持つ種族すべてに計上する (多種族カードを取りこぼさない)。最も枚数の多い種族が
 * 過半を占めればそれを返し、そうでなければ null (トライバルでない)。同率首位は**種族名の昇順**で
 * 決定的に選ぶ (実行ごとに結果が変わらないように)。
 */
export function computeTribalSynergy(cards: Card[]): TribalSynergy | null {
  if (cards.length < MIN_CARDS) return null;

  const counts = new Map<string, number>();
  for (const card of cards) {
    for (const race of card.races) {
      counts.set(race, (counts.get(race) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return null;

  // 枚数降順 → 同率は種族名昇順。先頭が支配種族。
  const [tribe, count] = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
  const ratio = count / cards.length;
  if (ratio < TRIBAL_RATIO) return null;
  return { tribe, count, ratio };
}
