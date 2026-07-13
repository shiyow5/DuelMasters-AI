import { z } from "zod";
import {
  CIVILIZATIONS,
  CARD_TYPES,
  FORMATS,
  RESTRICTION_TYPES,
  ROLE_TAGS,
  DOC_TYPES,
  TIERS,
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
      win_rate: z.number().nullable().default(null),
      sample_decklist: z.array(DeckEntrySchema).nullable().default(null),
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
    }),
  ),
  total: z.number(),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

/** ===== API リクエストスキーマ (apps/api の入力検証用) ===== */

/** POST /api/chat */
export const ChatRequestSchema = z.object({
  message: z.string().min(1, "message は必須です"),
  mode: ChatModeSchema.default("integrated"),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string(),
      }),
    )
    .default([]),
  format: z.enum(FORMATS).optional(),
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

/** PUT /api/user/settings */
export const UserSettingsRequestSchema = z.object({
  format: z.enum(FORMATS),
});
export type UserSettingsRequest = z.infer<typeof UserSettingsRequestSchema>;

/** ingest:tags の LLM 出力検証 (カード名 → 役割タグ) */
export const TagExtractionSchema = z.array(
  z.object({
    name: z.string(),
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
