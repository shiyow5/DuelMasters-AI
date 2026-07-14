-- カードの役割タグ付与を「増分」にする (#120)。
--
-- 背景: ingest-tags の onlyEmpty は `WHERE jsonb_array_length(tags) = 0` で対象を選ぶ。
-- ところが **LLM がタグを1つも返さなかったカードは tags = [] のまま残る**ので、次回実行で
-- 必ず再選択され、また LLM に投げられる。cron に組み込むと、その約5000件を**毎週課金し続け、
-- 永久に収束しない**。
--
-- 「タグが空である」ことと「タグ付けを試したかどうか」は別の情報。列を分ける。
--
-- updated_at は使えない。ingest-cards の ON CONFLICT DO UPDATE が中身の変化に関わらず
-- 毎回 NOW() を打つので、週次のカード取込で全行が「更新済み」になってしまう。

ALTER TABLE cards ADD COLUMN IF NOT EXISTS tags_updated_at TIMESTAMPTZ;

-- 既にタグが付いている行は「試行済み」とみなす (再課金しない)。
UPDATE cards SET tags_updated_at = updated_at
WHERE tags_updated_at IS NULL AND jsonb_array_length(tags) > 0;

-- 未試行のカードだけを引く部分インデックス。増分実行のたびに全件走査しない。
CREATE INDEX IF NOT EXISTS cards_tags_pending_idx ON cards (id) WHERE tags_updated_at IS NULL;
