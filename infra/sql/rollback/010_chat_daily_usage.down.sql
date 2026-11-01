-- migration 010 (chat_daily_usage) のロールバック。**手で流すときだけ使う。workflow からは実行しない。**
--
-- このディレクトリ (infra/sql/rollback/) は CI の `infra/sql/*.sql` にも
-- docker の initdb (直下のファイルだけ) にも拾われない。
--
-- 使ってよい条件 (手順書 migration-010-apply-runbook.md §5):
-- - PR #156 のコードが本番にまだ無い (マージ前) → そのまま流してよい。
-- - マージ後 → **先にコードを戻す** (Cloudflare Rollback か #156 の Revert)。テーブルを先に消すと
--   fail-open でクォータが効かず、毎リクエストでエラーログが出る。
BEGIN;

DROP TABLE IF EXISTS public.chat_daily_usage;

COMMIT;

-- 確認: NULL に戻っていること
SELECT to_regclass('public.chat_daily_usage') AS chat_daily_usage;
