-- DM-AI: 初期DDL
-- pgvector 拡張を有効化
CREATE EXTENSION IF NOT EXISTS vector;

-- カードマスタ
CREATE TABLE IF NOT EXISTS cards (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  civilizations JSONB NOT NULL DEFAULT '[]',
  cost INTEGER NOT NULL DEFAULT 0,
  type VARCHAR(50) NOT NULL,
  races JSONB NOT NULL DEFAULT '[]',
  text TEXT NOT NULL DEFAULT '',
  power INTEGER,
  is_rainbow BOOLEAN NOT NULL DEFAULT FALSE,
  is_shield_trigger BOOLEAN NOT NULL DEFAULT FALSE,
  tags JSONB NOT NULL DEFAULT '[]',
  card_image_url TEXT,
  official_id VARCHAR(50),
  set_code VARCHAR(50),
  rarity VARCHAR(20),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS cards_name_idx ON cards (name);
CREATE INDEX IF NOT EXISTS cards_official_id_idx ON cards (official_id);

-- 殿堂レギュレーション
CREATE TABLE IF NOT EXISTS regulations (
  id SERIAL PRIMARY KEY,
  format VARCHAR(20) NOT NULL,
  restriction_type VARCHAR(30) NOT NULL,
  card_name TEXT NOT NULL,
  effective_from DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS regulations_card_name_idx ON regulations (card_name);
CREATE INDEX IF NOT EXISTS regulations_format_idx ON regulations (format);

-- ルールRAG用チャンク
CREATE TABLE IF NOT EXISTS rule_chunks (
  id SERIAL PRIMARY KEY,
  doc_type VARCHAR(30) NOT NULL,
  version VARCHAR(20) NOT NULL DEFAULT '',
  chunk_text TEXT NOT NULL,
  chunk_meta JSONB NOT NULL DEFAULT '{}',
  embedding VECTOR(768),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS rule_chunks_doc_type_idx ON rule_chunks (doc_type);

-- HNSW インデックス (ベクトル検索高速化)
CREATE INDEX IF NOT EXISTS rule_chunks_embedding_idx
  ON rule_chunks
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- デッキ保存
CREATE TABLE IF NOT EXISTS decks (
  id SERIAL PRIMARY KEY,
  format VARCHAR(20) NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  cards JSONB NOT NULL,
  user_id VARCHAR(100),
  scores JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS decks_user_id_idx ON decks (user_id);
CREATE INDEX IF NOT EXISTS decks_format_idx ON decks (format);

-- 大会結果
CREATE TABLE IF NOT EXISTS tournament_results (
  id SERIAL PRIMARY KEY,
  event_name TEXT NOT NULL,
  event_date DATE NOT NULL,
  format VARCHAR(20) NOT NULL,
  participants INTEGER,
  deck_archetype TEXT NOT NULL,
  placement INTEGER NOT NULL,
  source_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS tournament_results_date_idx ON tournament_results (event_date);
CREATE INDEX IF NOT EXISTS tournament_results_archetype_idx ON tournament_results (deck_archetype);
CREATE INDEX IF NOT EXISTS tournament_results_format_idx ON tournament_results (format);

-- メタスナップショット
CREATE TABLE IF NOT EXISTS meta_snapshots (
  id SERIAL PRIMARY KEY,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  format VARCHAR(20) NOT NULL,
  tier_data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS meta_snapshots_format_idx ON meta_snapshots (format);
CREATE INDEX IF NOT EXISTS meta_snapshots_period_idx ON meta_snapshots (period_start, period_end);
