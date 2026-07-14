import type { Card, RoleTag } from "@dm-ai/core";

/**
 * 受け札か (S・トリガー / ブロッカー / S・バック / ニンジャ・ストライク / G・ストライク)。
 *
 * **カード自身の情報だけで判定できる。** `is_shield_trigger` は cards テーブルの列で、
 * テキストのキーワードも DB にある。タグ (`cards.tags`) を待つ必要が無い。
 *
 * scorer もこれを使う (#120)。タグが未整備でも受け札の判定は正しくできるので、
 * 「S・トリガーを20枚積んだデッキに受け札が少ないと警告する」ような事故を原理的に防ぐ。
 */
export function isDefensiveCard(card: Card): boolean {
  return (
    card.is_shield_trigger ||
    /ブロッカー|S・バック|Ｓ・バック|ニンジャ・ストライク|G・ストライク|Ｇ・ストライク/.test(
      card.text,
    )
  );
}

/**
 * 照合用にテキストを正規化する。
 *
 * **カードテキストの数字はほぼ全角。** 公式サイトは「カードを２枚引く」と書く
 * (実測: 全角 1279件 / 半角 4件)。`\d` は全角にマッチしないので、
 * `/カードを(\d+枚)?引/` は**約1263件のドロー札を取りこぼしていた** (ドロータグが付いたのは16件)。
 * 「Ｗ・ブレイカー」(全角W) も同じ穴。#111 の中黒と同じ病気なので、同じ手当てをする。
 */
function normalizeText(text: string): string {
  return text.normalize("NFKC");
}

/** 「カードを(N枚)(まで)引く/引き」。「まで」を許さないと《サイバー・ブレイン》を落とす (実測 +60件)。 */
const DRAW = /カードを(\d+枚)?(まで)?引/;

/** 「相手はカードを◯枚引く」= **相手のドロー**。デメリットであって、自分のドローソースではない。 */
const OPPONENT_DRAW = /相手は\s*カードを(\d+枚)?(まで)?引[くき]/g;

/**
 * 自分のドローがあるか。
 *
 * **相手のドローを先に文面から取り除いてから判定する。** 単に「相手」を含む文を捨てると、
 * 《侵略者 BJ》(「**相手の**シールドが0つ以下なら、カードを1枚まで引く」) のような
 * **自分のドロー**まで巻き添えで落ちる。逆に除かないと《黒神龍ザルバ》
 * (「相手はカードを1枚引く」) のようなデメリット持ち 37件をドロー札と誤認する。
 */
function hasSelfDraw(normalizedText: string): boolean {
  return DRAW.test(normalizedText.replace(OPPONENT_DRAW, ""));
}

/** ルールベースの役割タグ推定。確信が持てるタグのみ返す (0個もあり得る) */
export function inferTagsByRule(card: Card): RoleTag[] {
  const tags = new Set<RoleTag>();
  const text = normalizeText(card.text);

  if (isDefensiveCard(card)) tags.add("受け");
  // ドロー。**相手のドローは自分のドローソースではない** — 先に除いてから見る。
  if (hasSelfDraw(text)) tags.add("ドロー");
  // ブースト: 山札の上からマナゾーンに置く
  if (/山札の上から.{0,10}マナゾーンに置/.test(text)) tags.add("ブースト");
  // 除去: 相手のクリーチャーへの破壊/バウンス/マナ送り/シールド送り/封印
  if (/相手の.{0,30}(破壊する|手札に戻す|マナゾーンに置く|シールド.{0,10}加える|封印)/.test(text)) {
    tags.add("除去");
  }
  // メタ: 行動制約系の文言
  if (/召喚できない|唱えられない|選ばれない|攻撃できない|コストを.{0,6}多く支払う/.test(text)) {
    tags.add("メタ");
  }
  // 初動: コスト3以下で ブースト/ドロー いずれかを持つ
  if (card.cost <= 3 && (tags.has("ブースト") || tags.has("ドロー"))) tags.add("初動");
  // フィニッシャー: コスト6以上かつ (Wブレイカー以上 or パワー9000以上)
  if (
    card.cost >= 6 &&
    // text は NFKC 済みなので全角 Ｗ/Ｔ は W/T になっている
    (/(W|T|ワールド)・?ブレイカー/.test(text) || (card.power ?? 0) >= 9000)
  ) {
    tags.add("フィニッシャー");
  }
  return [...tags];
}
