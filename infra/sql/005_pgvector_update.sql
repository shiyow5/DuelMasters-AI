-- pgvector を最新へ更新する (冪等)。
--
-- ルール検索は pgvector 0.8 の反復スキャン (hnsw.iterative_scan) に依存する。
-- HNSW は近傍を先に取ってから WHERE を適用する (後置フィルタ) ため、これが無いと
-- doc_type で絞った検索が「該当行が存在するのに 0 行」を返す。
--
-- 001_init.sql の CREATE EXTENSION は既存 DB では何もしないので、拡張のバージョンは
-- 作成時のまま据え置かれる。既存の Docker ボリュームや Supabase プロジェクトを確実に
-- 0.8 以上へ上げるため、番号付きマイグレーションとして分けて置く。
ALTER EXTENSION vector UPDATE;
