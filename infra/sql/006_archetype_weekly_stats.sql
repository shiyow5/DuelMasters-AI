-- 週次のアーキタイプ入賞数集計。
--
-- 背景: メタのティア表は tournament_results (CS ごとの入賞デッキ) を数えて作っていたが、
-- 取込元 (田園補完計画) が「記事化する CS」は集計している母集団のごく一部でしかない。
-- 実測 (2026/7/6〜7/12, オリジナル): 個別 CS 記事から拾えるのは 11大会 × 4入賞 = 44件。
-- 同じ週の入賞数ランキング記事の母数は 274件。つまり個別記事だけを数えると母集団の 16%
-- しか見ておらず、しかも「ブログが記事にした CS」に偏った標本になる。
--
-- そこで週次ランキング記事 (フォーマットごとに週1本) を一次ソースとしてここに保存し、
-- ティア表はこれを集計して作る。tournament_results は引き続き個別 CS 記事から埋め、
-- 「このアーキタイプが直近どの大会で入賞したか」の履歴表示に使う。役割を分ける。
CREATE TABLE IF NOT EXISTS archetype_weekly_stats (
  format         VARCHAR(20) NOT NULL,
  period_start   DATE NOT NULL,
  period_end     DATE NOT NULL,
  deck_archetype TEXT NOT NULL,
  -- 当該アーキタイプの入賞数
  entries        INTEGER NOT NULL,
  -- その週その形式の入賞デッキ総数 (母数)。週ごとに一定なので冗長だが、
  -- 集計時に週の重みを正しく扱うために行に持たせる。
  total_entries  INTEGER NOT NULL,
  source_url     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (format, period_start, period_end, deck_archetype)
);

CREATE INDEX IF NOT EXISTS archetype_weekly_stats_period_idx
  ON archetype_weekly_stats (format, period_end);

-- 004 と同じ方針: public スキーマのテーブルは PostgREST に自動公開されるため RLS を有効化し、
-- ポリシーは付けない (anon/authenticated を全面拒否)。アプリは postgres ロールで迂回する。
ALTER TABLE archetype_weekly_stats ENABLE ROW LEVEL SECURITY;
