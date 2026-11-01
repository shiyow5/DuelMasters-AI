-- /api/chat のユーザー単位・日次の呼び出し回数 (F-1: LLM コストの暴走対策)。
--
-- 分単位のレート制限 (Workers の Rate Limiting binding) だけでは、1日を通して叩き続けると
-- Gemini の課金か無料枠を1人で食い潰せる。apps/api/src/middleware/daily-quota.ts が
-- 1リクエストごとに UPSERT で数え、上限を超えたら 429 を返す。
--
-- usage_date は JST の日付 (アプリ側で計算して渡す)。古い行は数えるのに使わないので、
-- 消さなくても挙動は変わらない (1ユーザー1日1行で、量は小さい)。
CREATE TABLE IF NOT EXISTS chat_daily_usage (
  -- 'supabase:<uuid>' (Web) / 'discord:<id>' (bot)。conversations.user_id と同じ形式。
  user_id    VARCHAR(100) NOT NULL,
  usage_date DATE NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, usage_date)
);

-- 004 と同じ方針: public スキーマのテーブルは PostgREST に自動公開されるため RLS を有効化し、
-- ポリシーは付けない (anon/authenticated を全面拒否)。アプリは postgres ロールで迂回する。
ALTER TABLE chat_daily_usage ENABLE ROW LEVEL SECURITY;
