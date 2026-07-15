import type { Card, DeckConcept } from "@dm-ai/core";
import { isDefensiveCard, REMOVAL_RE } from "./tagger.js";

export type { DeckConcept };

/**
 * デッキ全体の戦略コンセプト (#130)。
 *
 * 役割タグ (#120) は「初動/受け/除去/…」というカード単位の分類。だが「無限ループで勝つ」
 * 「受けを絞って除去で捌く」のような**デッキ全体の戦略**は別レイヤ。これが無いと scorer が
 * 全デッキをビートダウン前提のテンプレで採点し、コンボ/コントロールを不当に減点する
 * (例: ループデッキは受けやフィニッシャーを意図的に絞るのに「受け不足」と減点される)。
 *
 * **厳密なコンボ成立判定はしない** (カード相互作用の探索が要る)。カードテキストの粗い信号と
 * クリーチャー比・コストから、combo / control / beatdown を**確信が持てるときだけ**返す。
 * 確信が無ければ `unknown` を返し、scorer は通常どおり (=緩和しない) 採点する。
 */

/** カードテキストの数字はほぼ全角。tagger と同じく NFKC で正規化してから照合する (#111 の轍)。 */
function normalize(text: string): string {
  return text.normalize("NFKC");
}

/**
 * ループ/コンボの**強い**信号。
 *
 * 「多くのデッキに出る」語は入れない。特に **「山札の一番下」は除外した** — 《母なる大地》の
 * 「残りを好きな順序で山札の一番下に置く」のように、コンボ性の無い汎用ドロー/セレクト呪文の
 * 定型句で、これを入れるとビートダウンを combo と誤判定してしまう (レビュー指摘)。
 */
const COMBO_SIGNAL =
  /無限|好きなだけ|繰り返|このターン.{0,15}(もう一度|追加のターン)|次のターン.{0,10}追加/;

/** これ未満のカード数では分類の材料が足りない (パースだけで展開できていない等)。 */
const MIN_CARDS = 20;
/**
 * combo と判定する条件は**種類数と合計枚数の両方**で見る。
 *
 * - **種類数**だけだと、コンボ信号を持つカードを各1枚だけ3種入れた (合計3/40枚) デッキが
 *   combo になり、まばらな枠でも緩和が効いてしまう (Codex/レビュー指摘)。
 * - **合計枚数**だけだと、汎用ドロー呪文を1プレイセット (1種4枚) 積んだだけで到達する
 *   (最初のレビュー指摘)。
 *
 * そこで「異なるカード名で `COMBO_MIN_KINDS` 種以上」かつ「合計 `COMBO_MIN_COPIES` 枚以上」の
 * 両方を満たすときだけ combo とする。1〜2部品のループデッキ (各プレイセット) は拾いつつ、
 * 1プレイセットだけ・シングルトン3種のような誤検出を防ぐ。
 */
const COMBO_MIN_KINDS = 2;
const COMBO_MIN_COPIES = 6;
/** コントロール: クリーチャー比がこれ以下。 */
const CONTROL_CREATURE_MAX = 0.4;
/** コントロール: 受け + 除去 の合計がこれ以上 (相互作用が厚い)。 */
const CONTROL_INTERACTION_MIN = 12;
/** ビートダウン: クリーチャー比がこれ以上。 */
const BEATDOWN_CREATURE_MIN = 0.6;
/** ビートダウン: 平均コストがこれ以下 (低く速い)。 */
const BEATDOWN_AVG_COST_MAX = 3.5;

function isCreature(card: Card): boolean {
  return card.type === "creature" || card.type === "star_evolution_creature";
}

/**
 * デッキ (展開済みカード列) の戦略コンセプトを推定する。純粋関数。
 *
 * 判定は保守的: combo → control → beatdown の順に**確信が持てる条件**を満たせばそれを返し、
 * どれにも当てはまらなければ `unknown`。beatdown は現行の採点と同じ扱いなので、
 * 実質的に意味を持つのは combo / control (減点を緩和する対象) と unknown (緩和しない)。
 */
export function inferDeckConcept(cards: Card[]): DeckConcept {
  if (cards.length < MIN_CARDS) return "unknown";

  // コンボ信号を持つカード (展開済み=枚数ぶん)。種類数と合計枚数の両方で combo を判定する。
  const comboCards = cards.filter((c) => COMBO_SIGNAL.test(normalize(c.text)));
  const comboKinds = new Set(comboCards.map((c) => c.name)).size;
  const creatureRatio = cards.filter(isCreature).length / cards.length;
  const defenseCount = cards.filter(isDefensiveCard).length;
  const removalCount = cards.filter((c) => REMOVAL_RE.test(normalize(c.text))).length;
  const avgCost = cards.reduce((sum, c) => sum + c.cost, 0) / cards.length;

  if (comboKinds >= COMBO_MIN_KINDS && comboCards.length >= COMBO_MIN_COPIES) return "combo";
  if (
    creatureRatio <= CONTROL_CREATURE_MAX &&
    defenseCount + removalCount >= CONTROL_INTERACTION_MIN
  )
    return "control";
  if (creatureRatio >= BEATDOWN_CREATURE_MIN && avgCost <= BEATDOWN_AVG_COST_MAX) return "beatdown";
  return "unknown";
}

/** combo / control は「受け・フィニッシャーを意図的に絞る」ことがあるので減点を緩和する対象。 */
export function isRelaxedConcept(concept: DeckConcept): boolean {
  return concept === "combo" || concept === "control";
}

/** 警告文などに使う日本語ラベル。 */
export function conceptLabel(concept: DeckConcept): string {
  switch (concept) {
    case "combo":
      return "コンボ";
    case "control":
      return "コントロール";
    case "beatdown":
      return "ビートダウン";
    default:
      return "不明";
  }
}
