import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  date,
  varchar,
  uuid,
  index,
  uniqueIndex,
  real,
} from "drizzle-orm/pg-core";

/** カスタム pgvector カラム (drizzle は vector をネイティブ非対応なので customType で対応) */
import { customType } from "drizzle-orm/pg-core";

const vector = customType<{
  data: number[];
  config: { dimensions: number };
  driverParam: string;
}>({
  dataType(config) {
    return `vector(${config?.dimensions ?? 768})`;
  },
  fromDriver(value: unknown) {
    if (typeof value === "string") {
      return value.replace(/^\[/, "").replace(/]$/, "").split(",").map(Number);
    }
    return value as number[];
  },
  toDriver(value: number[]) {
    return `[${value.join(",")}]`;
  },
});

/** カードマスタ */
export const cards = pgTable(
  "cards",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    civilizations: jsonb("civilizations").$type<string[]>().notNull().default([]),
    cost: integer("cost").notNull().default(0),
    type: varchar("type", { length: 50 }).notNull(),
    races: jsonb("races").$type<string[]>().notNull().default([]),
    text: text("text").notNull().default(""),
    power: integer("power"),
    is_rainbow: boolean("is_rainbow").notNull().default(false),
    is_shield_trigger: boolean("is_shield_trigger").notNull().default(false),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    /**
     * 役割タグの付与を**試した**日時 (#120)。
     *
     * `tags = []` は「タグが無い」であって「まだ試していない」ではない。LLM が1つも
     * 返さなかったカードも `[]` になるので、これが無いと毎回そのカードを再課金してしまう。
     * NULL = 未試行。
     */
    tags_updated_at: timestamp("tags_updated_at", { withTimezone: true }),
    card_image_url: text("card_image_url"),
    official_id: varchar("official_id", { length: 50 }),
    set_code: varchar("set_code", { length: 50 }),
    rarity: varchar("rarity", { length: 20 }),
    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("cards_name_idx").on(table.name),
    uniqueIndex("cards_official_id_uidx").on(table.official_id),
  ],
);

/** 殿堂レギュレーション */
export const regulations = pgTable(
  "regulations",
  {
    id: serial("id").primaryKey(),
    format: varchar("format", { length: 20 }).notNull(),
    restriction_type: varchar("restriction_type", { length: 30 }).notNull(),
    card_name: text("card_name").notNull(),
    effective_from: date("effective_from").notNull(),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("regulations_card_name_idx").on(table.card_name),
    index("regulations_format_idx").on(table.format),
  ],
);

/** ルールRAG用チャンク */
export const ruleChunks = pgTable(
  "rule_chunks",
  {
    id: serial("id").primaryKey(),
    doc_type: varchar("doc_type", { length: 30 }).notNull(),
    version: varchar("version", { length: 20 }).notNull().default(""),
    chunk_text: text("chunk_text").notNull(),
    chunk_meta: jsonb("chunk_meta").$type<Record<string, unknown>>().notNull().default({}),
    embedding: vector("embedding", { dimensions: 768 }),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("rule_chunks_doc_type_idx").on(table.doc_type)],
);

/** デッキ保存 */
export const decks = pgTable(
  "decks",
  {
    id: serial("id").primaryKey(),
    format: varchar("format", { length: 20 }).notNull(),
    title: text("title").notNull().default(""),
    cards: jsonb("cards").$type<Array<{ name: string; count: number }>>().notNull(),
    user_id: varchar("user_id", { length: 100 }),
    scores: jsonb("scores").$type<Record<string, unknown>>(),
    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("decks_user_id_idx").on(table.user_id),
    index("decks_format_idx").on(table.format),
  ],
);

/** 大会結果 */
export const tournamentResults = pgTable(
  "tournament_results",
  {
    id: serial("id").primaryKey(),
    event_name: text("event_name").notNull(),
    event_date: date("event_date").notNull(),
    format: varchar("format", { length: 20 }).notNull(),
    participants: integer("participants"),
    deck_archetype: text("deck_archetype").notNull(),
    placement: integer("placement").notNull(),
    source_url: text("source_url"),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("tournament_results_date_idx").on(table.event_date),
    index("tournament_results_archetype_idx").on(table.deck_archetype),
    index("tournament_results_format_idx").on(table.format),
  ],
);

/** メタスナップショット */
export const metaSnapshots = pgTable(
  "meta_snapshots",
  {
    id: serial("id").primaryKey(),
    period_start: date("period_start").notNull(),
    period_end: date("period_end").notNull(),
    format: varchar("format", { length: 20 }).notNull(),
    tier_data: jsonb("tier_data")
      .$type<
        Array<{
          tier: string;
          archetype: string;
          usage_rate: number;
          win_rate: number | null;
          sample_decklist: Array<{ name: string; count: number }> | null;
        }>
      >()
      .notNull(),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("meta_snapshots_format_idx").on(table.format),
    index("meta_snapshots_period_idx").on(table.period_start, table.period_end),
  ],
);

/** ユーザー設定 */
export const userSettings = pgTable("user_settings", {
  user_id: varchar("user_id", { length: 100 }).primaryKey(),
  format: varchar("format", { length: 20 }).notNull().default("original"),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
});

/** 会話 (#110)。user_id で必ず絞ること — 他人の会話 ID を指定して読めてはいけない。 */
export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    user_id: varchar("user_id", { length: 100 }).notNull(),
    title: text("title").notNull(),
    mode: varchar("mode", { length: 20 }).notNull().default("integrated"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("conversations_user_idx").on(table.user_id, table.updated_at)],
);

/** 会話中の1発言。引用とツール呼び出しも残す (後から根拠を辿れないと保存する意味が薄い)。 */
export const conversationMessages = pgTable(
  "conversation_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversation_id: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 20 }).notNull(),
    content: text("content").notNull(),
    citations: jsonb("citations"),
    tool_calls: jsonb("tool_calls"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("conversation_messages_conv_idx").on(table.conversation_id, table.created_at)],
);

/** 「役に立った / 立たなかった」。eval の golden set 候補を実利用から拾うためのシグナル。 */
export const messageFeedback = pgTable("message_feedback", {
  message_id: uuid("message_id")
    .primaryKey()
    .references(() => conversationMessages.id, { onDelete: "cascade" }),
  user_id: varchar("user_id", { length: 100 }).notNull(),
  helpful: boolean("helpful").notNull(),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
