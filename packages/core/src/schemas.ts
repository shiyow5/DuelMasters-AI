import { z } from "zod";
import {
  CIVILIZATIONS,
  CARD_TYPES,
  FORMATS,
  RESTRICTION_TYPES,
  ROLE_TAGS,
  DOC_TYPES,
  TIERS,
  DECK_CONCEPTS,
  DECK_ARCHETYPES,
} from "./constants.js";

/** カード */
export const CardSchema = z.object({
  id: z.number().optional(),
  name: z.string(),
  civilizations: z.array(z.enum(CIVILIZATIONS)),
  cost: z.number().int().nonnegative(),
  type: z.enum(CARD_TYPES),
  races: z.array(z.string()).default([]),
  text: z.string().default(""),
  power: z.number().int().nonnegative().nullable().default(null),
  is_rainbow: z.boolean().default(false),
  is_shield_trigger: z.boolean().default(false),
  tags: z.array(z.enum(ROLE_TAGS)).default([]),
  card_image_url: z.string().url().nullable().default(null),
  official_id: z.string().nullable().default(null),
  set_code: z.string().nullable().default(null),
  rarity: z.string().nullable().default(null),
});
export type Card = z.infer<typeof CardSchema>;

/** 殿堂レギュレーション */
export const RegulationSchema = z.object({
  id: z.number().optional(),
  format: z.enum(FORMATS),
  restriction_type: z.enum(RESTRICTION_TYPES),
  card_name: z.string(),
  effective_from: z.string(),
});
export type Regulation = z.infer<typeof RegulationSchema>;

/** ルールチャンク */
export const RuleChunkSchema = z.object({
  id: z.number().optional(),
  doc_type: z.enum(DOC_TYPES),
  version: z.string().default(""),
  chunk_text: z.string(),
  chunk_meta: z
    .object({
      section: z.string().optional(),
      article: z.string().optional(),
      page: z.number().optional(),
      url: z.string().optional(),
    })
    .passthrough()
    .default({}),
  embedding: z.array(z.number()).optional(),
});
export type RuleChunk = z.infer<typeof RuleChunkSchema>;

/** デッキリスト内のカードエントリ */
export const DeckEntrySchema = z.object({
  name: z.string(),
  count: z.number().int().min(1).max(4),
});
export type DeckEntry = z.infer<typeof DeckEntrySchema>;

/** デッキ */
export const DeckSchema = z.object({
  id: z.number().optional(),
  format: z.enum(FORMATS),
  title: z.string().default(""),
  cards: z.array(DeckEntrySchema),
  user_id: z.string().nullable().default(null),
  scores: z
    .object({
      triggerCount: z.number().optional(),
      rainbowCount: z.number().optional(),
      costCurve: z
        .object({
          low: z.number(),
          mid: z.number(),
          high: z.number(),
        })
        .optional(),
      civilizationBalance: z.record(z.string(), z.number()).optional(),
      openingHandRate: z.number().optional(),
      roleBalance: z.record(z.string(), z.number()).optional(),
      overall: z.number().optional(),
    })
    .passthrough()
    .nullable()
    .default(null),
});
export type Deck = z.infer<typeof DeckSchema>;

/** 大会結果 */
export const TournamentResultSchema = z.object({
  id: z.number().optional(),
  event_name: z.string(),
  event_date: z.string(),
  format: z.enum(FORMATS),
  participants: z.number().int().nonnegative().nullable().default(null),
  deck_archetype: z.string(),
  placement: z.number().int().positive(),
  source_url: z.string().url().nullable().default(null),
});
export type TournamentResult = z.infer<typeof TournamentResultSchema>;

/** メタスナップショット */
export const MetaSnapshotSchema = z.object({
  id: z.number().optional(),
  period_start: z.string(),
  period_end: z.string(),
  format: z.enum(FORMATS),
  tier_data: z.array(
    z.object({
      tier: z.enum(TIERS),
      archetype: z.string(),
      usage_rate: z.number(),
      // **勝率は取込元に存在しない** (#122)。CS の入賞データからは原理的に計算できない
      // (入賞デッキしか分からないので、負けたデッキの母集団が無い)。
      // 常に null を返していたので、フィールドごと消した。
      entries: z.number(),
      total_entries: z.number(),
    }),
  ),
});
export type MetaSnapshot = z.infer<typeof MetaSnapshotSchema>;

/** チャットメッセージ */
export const ChatMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
  citations: z
    .array(
      z.object({
        text: z.string(),
        section: z.string().optional(),
        article: z.string().optional(),
        url: z.string().optional(),
      }),
    )
    .optional(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

/** チャットモード */
export const ChatModeSchema = z.enum(["rule", "deck", "meta", "integrated"]);
export type ChatMode = z.infer<typeof ChatModeSchema>;

/** ツール呼び出し */
export const ToolCallSchema = z.object({
  name: z.string(),
  args: z.record(z.string(), z.unknown()),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

/** デッキ評価結果 */
export const DeckScoreSchema = z.object({
  triggerCount: z.number(),
  rainbowCount: z.number(),
  costCurve: z.object({
    low: z.number(),
    mid: z.number(),
    high: z.number(),
  }),
  civilizationBalance: z.record(z.string(), z.number()),
  openingHandRate: z.number(),
  roleBalance: z.record(z.string(), z.number()),
  overall: z.number(),
  warnings: z.array(z.string()),
  suggestions: z.array(z.string()),
  /**
   * 推定したデッキ戦略コンセプト (#130)。combo/control のときは受け・フィニッシャー等の
   * 減点を緩和している。**optional** — 過去に保存した scores (concept 無し) も通すため。
   */
  concept: z.enum(DECK_CONCEPTS).optional(),
  /**
   * 推定したデッキアーキタイプ (#140)。aggro/midrange/control/combo ごとに S・トリガー/低コストの
   * 採点目標を切り替えている (ARCHETYPE_GUIDELINES)。**optional** — 過去に保存した scores
   * (archetype 無し) も通すため。
   */
  archetype: z.enum(DECK_ARCHETYPES).optional(),
  /**
   * 種族トライバルの軽量シナジー信号 (#141)。支配的な種族が過半を占めるときだけ入る (それ以外は null)。
   * **採点には影響しない情報提供のみ。** null = トライバルでない / 種族が乏しい。
   * **optional** — 過去に保存した scores (synergy 無し) も通すため。
   */
  synergy: z
    .object({
      tribe: z.string(),
      count: z.number(),
      ratio: z.number(),
    })
    .nullable()
    .optional(),
});
export type DeckScore = z.infer<typeof DeckScoreSchema>;

/** デッキバリデーション結果 */
export const ValidationResultSchema = z.object({
  valid: z.boolean(),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
});
export type ValidationResult = z.infer<typeof ValidationResultSchema>;

/** 検索結果 */
export const SearchResultSchema = z.object({
  chunks: z.array(
    z.object({
      text: z.string(),
      score: z.number(),
      meta: RuleChunkSchema.shape.chunk_meta,
      /**
       * 節の展開で補った兄弟条文か (#116)。context (モデルへの資料) には載せるが、
       * 出典 (citations) からは外す。**optional** — searchRules は必ず設定するが、
       * 過去に SearchResult を組んでいた箇所との後方互換のため。
       */
      expanded: z.boolean().optional(),
    }),
  ),
  total: z.number(),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

/** ===== API リクエストスキーマ (apps/api の入力検証用) ===== */

/** POST /api/chat */
export const ChatRequestSchema = z.object({
  // 上限が無いと、巨大な本文を投げ続けて Gemini のトークンと DB のストレージを食い潰せる
  // (#110 で発言を永続化したため、1回の課金で終わらず**恒久的に残る**ようになった)。
  message: z.string().min(1, "message は必須です").max(32_000, "message が長すぎます"),
  mode: ChatModeSchema.default("integrated"),
  /**
   * クライアントが持つ会話履歴。
   *
   * **conversationId がある場合は無視される** (#110)。履歴はサーバ (DB) を正とする。
   * クライアントの履歴を信じると、利用者が文脈を差し替えてモデルを誘導できてしまう。
   * conversationId が無いとき (bot・未ログイン経路) だけ、この履歴を使う。
   */
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string(),
      }),
    )
    .default([]),
  format: z.enum(FORMATS).optional(),
  /**
   * 会話 ID (#110)。指定すると履歴を DB から読み、発言を DB に保存する。
   * 他人の会話 ID を指定しても、所有者でなければ 404 になる。
   */
  conversationId: z.string().uuid().optional(),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

/** POST /api/deck/parse */
export const DeckParseRequestSchema = z.object({
  decklist: z.string().min(1, "decklist は必須です"),
});
export type DeckParseRequest = z.infer<typeof DeckParseRequestSchema>;

/** POST /api/deck/evaluate */
export const DeckEvaluateRequestSchema = z.object({
  decklist: z.string().min(1, "decklist は必須です"),
  format: z.enum(FORMATS).default("original"),
});
export type DeckEvaluateRequest = z.infer<typeof DeckEvaluateRequestSchema>;

/** POST /api/deck/build */
export const DeckBuildRequestSchema = z.object({
  theme: z.string().min(1, "theme は必須です"),
  format: z.enum(FORMATS).default("original"),
  constraints: z
    .object({
      requiredCards: z.array(z.string()).optional(),
      excludeCards: z.array(z.string()).optional(),
      civilizations: z.array(z.string()).optional(),
      maxCost: z.number().optional(),
      /** クリーチャーの最低枚数。未指定なら deck-engine 側の既定 (デッキの 55%) */
      minCreatures: z.number().int().positive().optional(),
    })
    .default({}),
});
export type DeckBuildRequest = z.infer<typeof DeckBuildRequestSchema>;

/** POST /api/deck/suggest */
export const DeckSuggestRequestSchema = z.object({
  decklist: z.string().min(1, "decklist は必須です"),
  goals: z.array(z.string()).default([]),
});
export type DeckSuggestRequest = z.infer<typeof DeckSuggestRequestSchema>;

/** POST /api/deck/save */
export const DeckSaveRequestSchema = z.object({
  title: z.string().min(1, "title は必須です").max(100),
  format: z.enum(FORMATS).default("original"),
  decklist: z.string().min(1, "decklist は必須です"),
});
export type DeckSaveRequest = z.infer<typeof DeckSaveRequestSchema>;

/**
 * POST /api/card/resolve — カード名から画像URLを引く (#129)。
 *
 * デッキのカードは最大 40 種。上限 200 は十分な余裕を持たせつつ、
 * 巨大な配列でクエリを食い潰されるのを防ぐ。
 */
export const CardResolveRequestSchema = z.object({
  // カード名1件あたりにも上限を設ける (この schema の message=32000 / title=100 と同じ思想)。
  // カード名が 200 文字を超えることはないので、巨大な文字列で translate/normalize を回させる
  // DoS 隣接の穴を塞ぐ。
  names: z
    .array(z.string().min(1).max(200))
    .min(1, "names は必須です")
    .max(200, "names が多すぎます"),
});
export type CardResolveRequest = z.infer<typeof CardResolveRequestSchema>;

/** PUT /api/user/settings */
export const UserSettingsRequestSchema = z.object({
  format: z.enum(FORMATS),
});
export type UserSettingsRequest = z.infer<typeof UserSettingsRequestSchema>;

/** ingest:tags の LLM 出力検証 (カード名 → 役割タグ) */
/**
 * 役割タグ推定の応答 (#120)。
 *
 * **カード名ではなくバッチ内の通し番号で突き合わせる。** 名前で照合すると、Gemini が名前を
 * 正規化・改変・欠落させたときに黙って取りこぼす。tags_updated_at で「試行済み」を刻む以上、
 * その取りこぼしは恒久化する (二度と再試行されない)。
 *
 * `.positive()` は使わない (exclusiveMinimum になり Gemini の function declaration が 400)。
 */
export const TagExtractionSchema = z.array(
  z.object({
    no: z.number().int().min(1),
    tags: z.array(z.enum(ROLE_TAGS)),
  }),
);
export type TagExtraction = z.infer<typeof TagExtractionSchema>;

/** 大会結果ページからの抽出結果 (Gemini 構造化出力の検証用) */
export const TournamentExtractionSchema = z.object({
  event_name: z.string().min(1),
  event_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  participants: z.number().int().positive().nullable(),
  results: z
    .array(
      z.object({
        deck_archetype: z.string().min(1),
        placement: z.number().int().positive(),
      }),
    )
    .min(1),
});
export type TournamentExtraction = z.infer<typeof TournamentExtractionSchema>;

/** POST /api/meta/ingest/url リクエスト */
export const IngestUrlRequestSchema = z.object({
  url: z.string().url(),
  format: z.enum(FORMATS).default("original"),
});
export type IngestUrlRequest = z.infer<typeof IngestUrlRequestSchema>;
