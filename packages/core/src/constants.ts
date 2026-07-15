/** デュエル・マスターズ 定数定義 */

/** フォーマット */
export const FORMATS = ["original", "advance"] as const;
export type Format = (typeof FORMATS)[number];

/** 文明 */
export const CIVILIZATIONS = ["fire", "water", "nature", "light", "darkness"] as const;
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
export const RESTRICTION_TYPES = ["殿堂入り", "プレミアム殿堂", "プレミアム殿堂コンビ"] as const;
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

/** デッキ全体の戦略コンセプト (#130)。役割タグ (カード単位) より上のレイヤ。 */
export const DECK_CONCEPTS = ["combo", "control", "beatdown", "unknown"] as const;
export type DeckConcept = (typeof DECK_CONCEPTS)[number];

/** ティア区分 (#132)。
 *
 * Tier1〜Tier5 の5段 + 「その他」(ノイズフロア以下のロングテール)。
 * **旧 Tier1/2/3 の値はそのまま残す** — 過去に保存した3段スナップショットが z.enum(TIERS) の
 * 検証を通り続けるようにするため (後方互換)。追加するだけで削除しない。 */
export const MAIN_TIERS = ["Tier1", "Tier2", "Tier3", "Tier4", "Tier5"] as const;
/** ノイズフロア以下 (単発入賞のロングテール) を入れる区分。UI は折りたたみで出す。 */
export const TIER_BELOW = "その他";
export const TIERS = ["Tier1", "Tier2", "Tier3", "Tier4", "Tier5", "その他"] as const;
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
export const DOC_TYPES = ["comprehensive_rules", "ruling", "faq"] as const;
export type DocType = (typeof DOC_TYPES)[number];

/** ティア分類のパラメータ (#132)。
 *
 * **固定閾値をやめ、順位ベースの相対分類にする。** 使用率 (=入賞シェア) は全アーキタイプの平均が
 * 1/N で、DM のヘビーテール分布では先頭1〜2個だけが高シェア・残りは急落する。固定の絶対閾値
 * (旧: 15% / 8%) だと 8-15% の中間帯が構造的に空き、Tier1 と Tier3 しか出なかった。
 * 有意アーキタイプを使用率降順に並べ、順位で `count` 段に等分すれば中間帯は空かない。 */
export const TIER_PARAMS = {
  /** 段数 (Tier1〜TierN)。 */
  count: 5,
  /** これ未満の使用率シェアは「その他」へ落とす (ロングテールを段に混ぜない)。 */
  noiseFloor: 0.02,
  /** これ未満の入賞数は「その他」へ落とす (母数が小さいと高シェアでも1件は誤差)。 */
  minEntries: 2,
} as const;
