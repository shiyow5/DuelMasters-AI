-- CS 入賞デッキレシピ (デネブログ)。**ティア表とは連携しない。**
--
-- 背景 (#126): 環境分析のティア行に「そのデッキのデッキリスト画像」を出したかったが、
-- 着手前の実測でデネブログをティアに紐づけるのは不可能と判明した:
--
--   - アーキタイプ名の一致率は 35/79 = 44.3% (完全一致は 15/79 = 19.0%)。
--     デネブログは「赤白ウィリデ」「シャコガイル入り創世竜」のように色やキーカードを
--     冠した名前を使い、ティア表 (田園補完計画の週次ランキング) は「ウィリデ」に束ねている。
--   - 代替案の「大会名で突き合わせる」は 5/79 = 6.3% とさらに低い。両ブログはそもそも
--     別の CS を記事にしている (田園補完計画は母数274に対し記事44/週)。
--   - **決定打: デネブログはフォーマット (オリジナル/アドバンス) を一切記録していない。**
--     記事本文・カテゴリ・タグのどこにも無い (実測)。ティア表はフォーマット別なので、
--     名前が一致しても行を選べない。しかも 16 アーキタイプ (ウィリデ・赤黒邪王門・創世竜・
--     デスパペット・無色ジョーカーズ 等の主力) が両フォーマットに同名で存在する。
--
--   フォーマットを消去法で推測すると、オリジナルの入賞デッキがアドバンスの行に載り、
--   そのフォーマットで使えないカードを含むリストを見せることになる。#122 の
--   「無関係なカードを出すくらいなら空欄」に反するため、推測はしない。
--
-- 方針: ティアに紐づけず、独立した「入賞デッキレシピ」一覧として持つ。
-- デネブログが書いていること (大会名・順位・デッキ名・プレイヤー・レシピ画像) だけを保存し、
-- 書いていないこと (フォーマット・正規化アーキタイプ) は**持たない**。
CREATE TABLE IF NOT EXISTS deck_recipes (
  -- 記事 URL が自然キー。1記事 = 1レシピ。
  source_url         TEXT PRIMARY KEY,
  -- 取込元の識別子。将来ほかのソースを足すときのため。
  source             VARCHAR(32) NOT NULL DEFAULT 'deneblog',
  -- 記事の**掲載日**。大会の開催日ではない (デネブログは開催日を書いていない)。
  -- 画面でも「掲載日」と表示すること。
  posted_date        DATE NOT NULL,
  event_name         TEXT NOT NULL,
  -- 「優勝」「準優勝」「3位」「ベスト8」等。順位は表記の幅が広く、数値化すると
  -- 「ベスト8 = 5位?」のような解釈が混ざるので、**ソースの表記のまま**持つ。
  placement_label    TEXT NOT NULL,
  -- デネブログ表記のデッキ名 (「赤白ウィリデ」)。ティアのアーキタイプ名とは別物。
  deck_name          TEXT NOT NULL,
  player             TEXT,
  participants       INTEGER,
  decklist_image_url TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 一覧は新着順。
CREATE INDEX IF NOT EXISTS deck_recipes_posted_idx ON deck_recipes (posted_date DESC);
-- デッキ名の部分一致検索 (pg_trgm は入れずに ILIKE で足りる規模: 記事は週100本程度)。
CREATE INDEX IF NOT EXISTS deck_recipes_deck_name_idx ON deck_recipes (deck_name);

-- 004 と同じ方針: public スキーマのテーブルは PostgREST に自動公開されるため RLS を有効化し、
-- ポリシーは付けない (anon/authenticated を全面拒否)。アプリは postgres ロールで迂回する。
ALTER TABLE deck_recipes ENABLE ROW LEVEL SECURITY;
