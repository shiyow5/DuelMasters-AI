import type { Card, RoleTag } from "@dm-ai/core";

/** ルールベースの役割タグ推定。確信が持てるタグのみ返す (0個もあり得る) */
export function inferTagsByRule(card: Card): RoleTag[] {
  const tags = new Set<RoleTag>();
  const text = card.text;

  // 受け: S・トリガー / ブロッカー / S・バック / ニンジャ・ストライク / G・ストライク
  if (
    card.is_shield_trigger ||
    /ブロッカー|S・バック|Ｓ・バック|ニンジャ・ストライク|G・ストライク|Ｇ・ストライク/.test(
      text
    )
  ) {
    tags.add("受け");
  }
  // ドロー: 「カードを(N枚)引く」
  if (/カードを(\d+枚)?引/.test(text)) tags.add("ドロー");
  // ブースト: 山札の上からマナゾーンに置く
  if (/山札の上から.{0,10}マナゾーンに置/.test(text)) tags.add("ブースト");
  // 除去: 相手のクリーチャーへの破壊/バウンス/マナ送り/シールド送り/封印
  if (
    /相手の.{0,30}(破壊する|手札に戻す|マナゾーンに置く|シールド.{0,10}加える|封印)/.test(
      text
    )
  ) {
    tags.add("除去");
  }
  // メタ: 行動制約系の文言
  if (
    /召喚できない|唱えられない|選ばれない|攻撃できない|コストを.{0,6}多く支払う/.test(
      text
    )
  ) {
    tags.add("メタ");
  }
  // 初動: コスト3以下で ブースト/ドロー いずれかを持つ
  if (card.cost <= 3 && (tags.has("ブースト") || tags.has("ドロー")))
    tags.add("初動");
  // フィニッシャー: コスト6以上かつ (Wブレイカー以上 or パワー9000以上)
  if (
    card.cost >= 6 &&
    (/(W|Ｗ|T|Ｔ|ワールド)・?ブレイカー/.test(text) || (card.power ?? 0) >= 9000)
  ) {
    tags.add("フィニッシャー");
  }
  return [...tags];
}
