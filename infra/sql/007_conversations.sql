-- 会話履歴とフィードバックの永続化 (#110)。
--
-- 背景: ログイン (Supabase Auth・招待制) を入れたのに userId に紐づくのは decks と
-- user_settings だけで、**会話履歴はどこにも保存されていなかった**。web は React の state に
-- 持つだけで、リロードすると全部消える。「役に立った」ボタンも state だけで、
-- **エージェント改善に使える唯一のシグナルを捨てていた**。

CREATE TABLE IF NOT EXISTS conversations (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Supabase は "supabase:<uuid>"、bot は Discord の user id。認証層が決める文字列をそのまま持つ。
  user_id    VARCHAR(100) NOT NULL,
  title      TEXT NOT NULL,
  mode       VARCHAR(20) NOT NULL DEFAULT 'integrated',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 一覧は「自分の会話を新しい順」でしか引かない。
CREATE INDEX IF NOT EXISTS conversations_user_idx ON conversations (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS conversation_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant')),
  content         TEXT NOT NULL,
  -- **引用とツール呼び出しも保存する。** これが無いと後から根拠を辿れず、保存する意味が薄い。
  citations       JSONB,
  tool_calls      JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS conversation_messages_conv_idx
  ON conversation_messages (conversation_id, created_at);

-- 「役に立った / 立たなかった」。**eval に直結する** — 低評価が付いた質問は golden set の候補。
CREATE TABLE IF NOT EXISTS message_feedback (
  message_id UUID PRIMARY KEY REFERENCES conversation_messages(id) ON DELETE CASCADE,
  user_id    VARCHAR(100) NOT NULL,
  helpful    BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 004 と同じ方針: public スキーマのテーブルは PostgREST に自動公開されるため RLS を有効化し、
-- **ポリシーは付けない** (anon/authenticated を全面拒否)。アプリは postgres ロールで迂回する。
-- ここを忘れると **anon 鍵で他人の会話が読める**。会話は decks 以上に機微。
ALTER TABLE conversations          ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_messages  ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_feedback       ENABLE ROW LEVEL SECURITY;
