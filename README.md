# DM-AI - デュエル・マスターズ Q&A ボット

デュエル・マスターズに特化した統合Q&Aボット。ルール確認・デッキ構築支援・環境分析・統合チャットの4機能を、RAG + 構造化DB + ツール実行のハイブリッドで実装しています。

## 機能一覧

### ルール確認

- 公式総合ルール(PDF)をRAGで検索
- 条文番号付きの引用で正確に回答
- 不確実な場合は「ジャッジに確認」を推奨

### デッキ構築支援

- デッキリストの解析・評価（100点満点スコアリング）
- 殿堂レギュレーションチェック
- テーマ指定による自動構築
- 改善提案

**評価指標:**

| 指標                    | 目安    |
| ----------------------- | ------- |
| S・トリガー             | 8枚     |
| 多色カード              | 8〜15枚 |
| コストカーブ (低/中/高) | 15/11/6 |
| 初動率 (2-3コスト)      | 70%以上 |

### 環境分析

- 大会結果に基づくティアリスト生成
- アーキタイプ別の使用率・入賞率
- 期間指定での集計（2週/4週/8週）

### 統合チャット

- Gemini Function Callingによる意図分類
- ルール・カード検索・デッキ評価・メタ分析を自動ルーティング

## 技術スタック

| レイヤー  | 技術                                                                |
| --------- | ------------------------------------------------------------------- |
| LLM       | Gemma 4 31B → Gemini 3.1 Flash Lite (コスト優先フォールバック)      |
| Agent     | LangGraph.js (状態機械 + 6ツール)                                   |
| Embedding | gemini-embedding-001 (768次元)                                      |
| Web       | Next.js 16 (App Router) + Tailwind CSS v4                           |
| API       | Hono on Cloudflare Workers (Hyperdrive 経由で Supabase)             |
| Bot       | Discord HTTP Interactions on Cloudflare Workers                     |
| DB        | Supabase (PostgreSQL + pgvector 0.8)                                |
| ORM       | Drizzle ORM                                                         |
| Monorepo  | pnpm workspaces + Turborepo                                         |
| Deploy    | Cloudflare Workers (api/bot/web) / GitHub Actions cron (取込バッチ) |

LLM は無料枠を優先し、失敗時に順次フォールバックする。**モデルは提供終了することがある**ため、
モデル名を変えたら `pnpm --filter @dm-ai/agent eval` を回して実 API で疎通を確認すること
(CI では検出できない)。

## プロジェクト構成

```
dm-ai/
├── apps/
│   ├── web/            # Next.js 16 - Web UI
│   ├── api/            # Hono - REST API
│   ├── bot/            # discord.js - Discord Bot
│   └── worker/         # データ取り込みジョブ
├── packages/
│   ├── core/           # 共通型(Zod) + 定数 + Geminiクライアント
│   ├── db/             # Supabase接続 + Drizzle ORMスキーマ
│   ├── rag/            # チャンク化・埋め込み・ハイブリッド検索
│   └── deck-engine/    # デッキ解析・評価・構築ロジック
├── infra/
│   ├── sql/            # DDL (pgvector + HNSWインデックス)
│   └── docker/         # Dockerfile群
├── docker-compose.yml
├── turbo.json
└── pnpm-workspace.yaml
```

## セットアップ

### 前提条件

- Node.js 20+
- pnpm 9+
- Docker (ローカルDB用)

### 1. 依存関係のインストール

```bash
pnpm install
```

### 2. 環境変数の設定

```bash
cp .env.example .env
```

`.env` を編集して以下を設定:

```env
# Gemini API
GEMINI_API_KEY=your_gemini_api_key

# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/dm_ai

# Discord (Bot使用時)
DISCORD_TOKEN=your_discord_bot_token
DISCORD_CLIENT_ID=your_client_id
DISCORD_GUILD_ID=your_guild_id  # 開発用サーバーID

# 内部API認証 (Bot/管理操作 → API。ランダムな長い文字列)
INTERNAL_API_KEY=long_random_string

# Web ログイン用 (値は SUPABASE_URL / SUPABASE_ANON_KEY と同じ)
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_anon_key
```

### 3. データベースの起動・初期化

```bash
# PostgreSQL + pgvector を起動
docker compose up db -d

# テーブル作成 (001 → 005 の順で適用)
psql $DATABASE_URL -f infra/sql/001_init.sql
psql $DATABASE_URL -f infra/sql/002_cards_official_id_unique.sql
psql $DATABASE_URL -f infra/sql/003_features.sql
psql $DATABASE_URL -f infra/sql/004_enable_rls.sql
psql $DATABASE_URL -f infra/sql/005_pgvector_update.sql
psql $DATABASE_URL -f infra/sql/006_archetype_weekly_stats.sql
```

`docker compose up db -d` で起動する場合は 001〜005 が初回に自動適用されます。

**005 は必須です。** ルール検索は pgvector 0.8 の反復スキャン (`hnsw.iterative_scan`) に依存します。
HNSW は近傍を先に取ってから `WHERE` を適用する (後置フィルタ) ため、これが無いと `doc_type` で
絞った検索が「該当条文が存在するのに 0 行」を返します。

**Supabase を使う場合は 004 の適用が必須です。** Supabase は public スキーマのテーブルを
PostgREST 経由で自動公開するため、RLS 未設定 (ダッシュボードの "Unrestricted") のままだと
公開鍵 (anon key) を持つ第三者が全テーブルを直接読み書きできます。004 は全テーブルで RLS を
有効化して PostgREST 経由のアクセスを遮断します。アプリのデータアクセスは Hyperdrive/
`DATABASE_URL` の postgres ロール (RLS を迂回) 経由なので、機能には影響しません。
Supabase を使う場合は、Supabase Dashboard の SQL Editor で 001 → 005 を順に実行してください。

### 4. データ取り込み

```bash
# ルールPDF取り込み (チャンク化 + 埋め込み生成)
pnpm --filter @dm-ai/worker ingest:rules

# カードデータ取り込み (公式サイトスクレイピング)
pnpm --filter @dm-ai/worker ingest:cards

# 殿堂レギュレーション取り込み
pnpm --filter @dm-ai/worker ingest:regulations

# 公式裁定 Q&A 取り込み (3000件超。改定前の重複質問は新しい裁定へ名寄せされる)
pnpm --filter @dm-ai/worker ingest:rulings

# カード役割タグ付与 (ルール → LLM フォールバック。--all で全カード)
pnpm --filter @dm-ai/worker ingest:tags

# FAQ・裁定取り込み
pnpm --filter @dm-ai/worker ingest:faq faq <url> [url...]

# 大会結果 (CS) 取り込み — 出典: 田園補完計画 (supersolenoid.jp)
#   週次入賞数ランキング → archetype_weekly_stats (ティア表の一次ソース)
#   個別 CS 記事        → tournament_results     (アーキタイプ別の入賞履歴)
#   --pages=N で遡るカテゴリページ数を指定 (既定 20 ≒ 過去5〜6週)
pnpm --filter @dm-ai/worker ingest:tournaments

# メタスナップショット生成 (<original|advance> [weeks])。ingest:tournaments の後に打つ
pnpm --filter @dm-ai/worker snapshot:meta original 4

# 既存カード種別の正規化 (日本語表記 → CardType enum)
pnpm --filter @dm-ai/worker fix:card-types
```

### 5. 開発サーバーの起動

```bash
# 全アプリ同時起動
pnpm dev
```

| アプリ | URL                   |
| ------ | --------------------- |
| Web    | http://localhost:3000 |
| API    | http://localhost:3001 |

### 6. Discord Bot のセットアップ

```bash
# スラッシュコマンドをDiscordに登録
pnpm --filter @dm-ai/bot deploy-commands

# Bot起動
pnpm --filter @dm-ai/bot dev
```

## API エンドポイント

一部エンドポイントは認証が必要です。Web は `Authorization: Bearer <Supabaseアクセストークン>`、Bot/内部操作は `X-Internal-Key`(+ `X-User-Id: discord:<id>`)を送ります。

### チャット

```
POST /api/chat
```

```json
{
  "message": "S・トリガーの処理順を教えて",
  "mode": "rule",
  "history": []
}
```

`mode`: `"integrated"` | `"rule"` | `"deck"` | `"meta"`

### デッキ

```
POST   /api/deck/parse      # デッキリスト解析
POST   /api/deck/evaluate   # 評価・診断
POST   /api/deck/build      # 自動構築
POST   /api/deck/suggest    # 改善提案
POST   /api/deck/save       # デッキ保存 (要認証)
GET    /api/deck/list       # マイデッキ一覧 (要認証)
GET    /api/deck/:id        # デッキ詳細 (要認証)
DELETE /api/deck/:id        # デッキ削除 (要認証)
```

### メタ

```
GET  /api/meta/tier?format=original&period=4w   # ティアリスト
GET  /api/meta/archetype/:name                   # アーキタイプ詳細
POST /api/meta/ingest/url                        # 大会結果URL取り込み (X-Internal-Key 必須)
```

### ユーザー設定

```
GET /api/user/settings   # フォーマット取得 (要認証)
PUT /api/user/settings   # フォーマット更新 (要認証)
```

## Discord コマンド

| コマンド                        | 説明                             |
| ------------------------------- | -------------------------------- |
| `/dm rule <質問>`               | ルール質問                       |
| `/dm deck rate <リスト>`        | デッキ評価                       |
| `/dm deck build <テーマ>`       | 自動構築                         |
| `/dm deck check <リスト>`       | 殿堂チェック                     |
| `/dm deck save <リスト> <名前>` | デッキ保存 (要 INTERNAL_API_KEY) |
| `/dm meta tier [期間]`          | ティア表                         |
| `/dm meta deck <名前>`          | アーキタイプ詳細                 |
| `/dm chat <メッセージ>`         | 統合チャット                     |
| `/dm format set <type>`         | フォーマット切替                 |

## ビルド

```bash
# 全体ビルド
pnpm build

# 個別ビルド
pnpm turbo build --filter=@dm-ai/api
pnpm turbo build --filter=@dm-ai/web
```

## 本番デプロイ (Cloudflare Workers)

main の CI が成功すると `.github/workflows/deploy.yml` が api / web Worker を自動デプロイする。
bot は Discord の Interactions Endpoint を差し替える性質上、`workflow_dispatch` で明示的に選んだときだけ出す。

| コンポーネント | URL                                                                             |
| -------------- | ------------------------------------------------------------------------------- |
| web            | https://dm-ai.shiyow.dev (Custom Domain) / https://dm-ai-web.shiyow.workers.dev |
| api            | https://dm-ai-api.shiyow.workers.dev                                            |
| bot            | https://dm-ai-bot.shiyow.workers.dev (Discord Interactions Endpoint)            |

手動デプロイに頼ると main と本番が乖離する (提供終了した Gemini モデルを使う古い Worker が
残り続け `/api/chat` が 500 を返していた実例あり)。

取込バッチは Node 依存 (pdf-parse 等) のため Cloudflare には載せず、
`.github/workflows/ingest-cron.yml` の cron で回す。殿堂は毎日、カード/ルール/裁定は週1。
`workflow_dispatch` でジョブを選んで手動実行もできる。

必要な GitHub Actions Secrets:

| Secret                  | 用途                                             |
| ----------------------- | ------------------------------------------------ |
| `CLOUDFLARE_API_TOKEN`  | Worker のデプロイ (Edit Cloudflare Workers 権限) |
| `CLOUDFLARE_ACCOUNT_ID` | 同上                                             |
| `DATABASE_URL`          | 取込 cron が Supabase に書き込む                 |
| `GEMINI_API_KEY`        | 取込 cron の埋め込み生成・タグ抽出               |

Worker 側の機密 (`GEMINI_API_KEY` / `INTERNAL_API_KEY` / `SUPABASE_*`) は
`wrangler secret put` で設定する (GitHub Secrets とは別管理)。

## Docker デプロイ (ローカル/自前ホスト)

```bash
# API
docker build -f infra/docker/api.Dockerfile -t dm-ai-api .

# Bot
docker build -f infra/docker/bot.Dockerfile -t dm-ai-bot .

# Worker
docker build -f infra/docker/worker.Dockerfile -t dm-ai-worker .

# 全体起動
docker compose up -d
```

## DB テーブル構成

| テーブル             | 用途                                                    |
| -------------------- | ------------------------------------------------------- |
| `cards`              | カードマスタ (名前, 文明, コスト, テキスト, 役割タグ等) |
| `regulations`        | 殿堂レギュレーション (フォーマット, 制限区分, カード名) |
| `rule_chunks`        | ルールRAG用チャンク (条文テキスト + 768次元ベクトル)    |
| `decks`              | デッキ保存 (カードリスト + 評価スコア + user_id)        |
| `tournament_results` | 大会結果 (アーキタイプ, 順位, 参加者数)                 |
| `meta_snapshots`     | メタ集計スナップショット (ティアデータ)                 |
| `user_settings`      | ユーザー設定 (フォーマット。Bot/Web 共通)               |

## ライセンス

Private
