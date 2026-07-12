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
