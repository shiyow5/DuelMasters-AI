-- cards.official_id を UNIQUE 化する (ingest-cards の ON CONFLICT (official_id) を機能させる)
-- 注意: 既存データに official_id の重複行がある場合は失敗する。その場合は重複行を手動で
-- 整理してから再実行すること。NULL は UNIQUE インデックスでは重複とみなされない。
DROP INDEX IF EXISTS cards_official_id_idx;
CREATE UNIQUE INDEX IF NOT EXISTS cards_official_id_uidx ON cards (official_id);
