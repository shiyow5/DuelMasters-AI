-- RLS (Row Level Security) を public スキーマの全テーブルで有効化する。
--
-- 背景: Supabase は public スキーマのテーブルを PostgREST 経由で自動的に REST API として
-- 公開する。RLS 無効 (ダッシュボード上の "Unrestricted") のままだと、web のJSバンドルに
-- 埋め込まれる公開鍵 (anon key) を持つ第三者が全テーブルを直接読み書きできてしまう。
-- decks / user_settings のユーザーデータ露出と、cards / rule_chunks 等のデータ破壊が起きうる。
--
-- 方針: RLS を有効化し、ポリシーは一切付けない (= anon / authenticated からのアクセスを全面拒否)。
-- 本アプリはテーブルを PostgREST 経由で触らないため、これで機能は一切壊れない:
--   - 全データアクセスは getSql() (Hyperdrive/DATABASE_URL の postgres ロール) 経由。
--     postgres はテーブル所有者かつ rolbypassrls=true なので RLS を迂回する。
--   - supabase-js は認証専用 (web=anon で auth.getSession、api=service_role で auth.getUser)。
--     コードベースに .from() によるテーブル直アクセスは存在しない。
--   - service_role キーも RLS を迂回する。
--
-- 将来 PostgREST 経由の直接アクセスが必要になったら、その時に最小権限のポリシーを追加する
-- (例: decks/user_settings は user_id = auth.uid() の行のみ)。API 側のバリデーションを
-- 迂回させないため、書き込みは API 経由に閉じるのが望ましい。

ALTER TABLE cards              ENABLE ROW LEVEL SECURITY;
ALTER TABLE rule_chunks        ENABLE ROW LEVEL SECURITY;
ALTER TABLE regulations        ENABLE ROW LEVEL SECURITY;
ALTER TABLE decks              ENABLE ROW LEVEL SECURITY;
ALTER TABLE tournament_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_snapshots     ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_settings      ENABLE ROW LEVEL SECURITY;
