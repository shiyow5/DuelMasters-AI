/** デュエル・マスターズ 定数定義 */

/** フォーマット */
export const FORMATS = ["original", "advance"] as const;
export type Format = (typeof FORMATS)[number];

/** 文明 */
export const CIVILIZATIONS = [
  "fire",
  "water",
  "nature",
  "light",
  "darkness",
] as const;
export type Civilization = (typeof CIVILIZATIONS)[number];

/** 文明の日本語名 */
export const CIVILIZATION_LABELS: Record<Civilization, string> = {
  fire: "火",
  water: "水",
  nature: "自然",
  light: "光",
  darkness: "闇",
};

/** カード種別 */
export const CARD_TYPES = [
  "creature",
  "spell",
  "cross_gear",
  "castle",
  "weapon",
  "field",
  "tamaseed",
  "star_evolution_creature",
] as const;
export type CardType = (typeof CARD_TYPES)[number];

/** 殿堂区分 */
export const RESTRICTION_TYPES = [
  "殿堂入り",
  "プレミアム殿堂",
  "プレミアム殿堂コンビ",
] as const;
export type RestrictionType = (typeof RESTRICTION_TYPES)[number];

/** 役割タグ */
export const ROLE_TAGS = [
  "初動",
  "受け",
  "除去",
  "ドロー",
  "フィニッシャー",
  "メタ",
  "ブースト",
] as const;
export type RoleTag = (typeof ROLE_TAGS)[number];

/** ティア区分 */
export const TIERS = ["Tier1", "Tier2", "Tier3"] as const;
export type Tier = (typeof TIERS)[number];

/** デッキ枚数制限 */
export const DECK_SIZE = 40;
export const MAX_COPIES = 4;

/** デッキ評価の目安値 */
export const DECK_GUIDELINES = {
  triggerCount: 8,
  rainbowMin: 8,
  rainbowMax: 15,
  /** 3コスト以下 / 4-6コスト / 7コスト以上 */
  costCurve: { low: 15, mid: 11, high: 6 } as const,
} as const;

/** ルール文書タイプ */
export const DOC_TYPES = [
  "comprehensive_rules",
  "ruling",
  "faq",
] as const;
export type DocType = (typeof DOC_TYPES)[number];
