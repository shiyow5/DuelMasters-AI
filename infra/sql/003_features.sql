-- ユーザー設定 (Bot のフォーマット設定永続化。将来 Web 設定にも使う)
CREATE TABLE IF NOT EXISTS user_settings (
  user_id VARCHAR(100) PRIMARY KEY,
  format VARCHAR(20) NOT NULL DEFAULT 'original',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 大会結果の重複取り込み防止 (同一URLの再取り込みを冪等にする)
-- format も同一大会が複数フォーマットで開催されるケースを区別するためキーに含める
CREATE UNIQUE INDEX IF NOT EXISTS tournament_results_dedup_uidx
  ON tournament_results (event_name, event_date, format, deck_archetype, placement);

-- メタスナップショットの期間重複防止 (snapshot:meta ジョブの UPSERT キー)
CREATE UNIQUE INDEX IF NOT EXISTS meta_snapshots_period_uidx
  ON meta_snapshots (format, period_start, period_end);
