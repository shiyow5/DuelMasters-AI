# DM-AI スタートアップガイド

このガイドでは、DM-AI を **ゼロから完全にデプロイする** までの全手順を解説します。
初心者の方でも迷わないよう、各ステップを詳しく説明しています。

---

## 目次

1. [前提条件の確認・インストール](#1-前提条件の確認インストール)
2. [リポジトリの準備](#2-リポジトリの準備)
3. [外部サービスのセットアップ](#3-外部サービスのセットアップ)
4. [環境変数の設定](#4-環境変数の設定)
5. [データベースの起動と初期化](#5-データベースの起動と初期化)
6. [ビルドと動作確認](#6-ビルドと動作確認)
7. [データの取り込み](#7-データの取り込み)
8. [ローカル開発サーバーの起動](#8-ローカル開発サーバーの起動)
9. [Discord Bot のセットアップ](#9-discord-bot-のセットアップ)
10. [本番デプロイ](#10-本番デプロイ)
11. [動作確認チェックリスト](#11-動作確認チェックリスト)
12. [トラブルシューティング](#12-トラブルシューティング)

---

## 1. 前提条件の確認・インストール

### 必須ソフトウェア

| ソフトウェア   | バージョン | 確認コマンド             |
| -------------- | ---------- | ------------------------ |
| Node.js        | 20 以上    | `node -v`                |
| pnpm           | 9 以上     | `pnpm -v`                |
| Docker         | 最新版     | `docker -v`              |
| Docker Compose | 最新版     | `docker compose version` |
| Git            | 最新版     | `git -v`                 |

### Node.js のインストール

まだインストールしていない場合は、[nvm (Node Version Manager)](https://github.com/nvm-sh/nvm) を使うのが便利です。

```bash
# nvm のインストール
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash

# ターミナルを再起動してから
nvm install 20
nvm use 20

# 確認
node -v   # v20.x.x と表示されればOK
```

### pnpm のインストール

```bash
npm install -g pnpm@9

# 確認
pnpm -v   # 9.x.x と表示されればOK
```

### Docker のインストール

- **Windows**: [Docker Desktop for Windows](https://docs.docker.com/desktop/install/windows-install/) をインストール
  - WSL2 バックエンドを有効にしてください
- **Mac**: [Docker Desktop for Mac](https://docs.docker.com/desktop/install/mac-install/) をインストール
- **Linux**: [Docker Engine](https://docs.docker.com/engine/install/) をインストール

```bash
# インストール確認
docker -v            # Docker version 2x.x.x
docker compose version   # Docker Compose version v2.x.x
```

---

## 2. リポジトリの準備

### クローンと依存関係のインストール

```bash
# リポジトリをクローン
git clone <リポジトリURL> dm-ai
cd dm-ai

# 依存関係をインストール（全パッケージ・全アプリ分）
pnpm install
```

> `pnpm install` は初回だと数分かかることがあります。
> 完了すると `node_modules/` ディレクトリが作成されます。

### インストール成功の確認

```bash
# ビルドが通るか確認
pnpm build
```

`Tasks: N successful, N total` と表示されれば成功です。

---

## 3. 外部サービスのセットアップ

DM-AI は 3 つの外部サービスを使用します。すべて無料枠で始められます。

### 3-1. Google AI (Gemini API キー)

LLM（チャット応答）と Embedding（ベクトル検索）に使用します。

1. [Google AI Studio](https://aistudio.google.com/) にアクセス
2. Google アカウントでログイン
3. 左メニューの **「Get API key」** をクリック
4. **「Create API key」** をクリック
5. 表示された API キーをコピーして控えておく

> 控えたキー例: `AIzaSyA1B2C3D4E5F6G7H8I9J0...`

### 3-2. Supabase (データベース)

PostgreSQL + pgvector をホスティングするサービスです。

1. [Supabase](https://supabase.com/) にアクセスしてアカウント作成
2. **「New Project」** をクリック
3. 以下を入力:
   - **Name**: `dm-ai`（任意）
   - **Database Password**: 強力なパスワードを設定（後で使うので控えておく）
   - **Region**: `Northeast Asia (Tokyo)` を選択
4. **「Create new project」** をクリック（作成に数分かかります）

#### 必要な情報を取得

プロジェクトが作成されたら、以下を控えます:

**Settings > API** から:

- **Project URL** → `SUPABASE_URL` として使用
  - 例: `https://abcdefghijk.supabase.co`
- **anon public key** → `SUPABASE_ANON_KEY` として使用
- **service_role key** → `SUPABASE_SERVICE_ROLE_KEY` として使用
  - 「Reveal」をクリックして表示

**Settings > Database** から:

- **Connection string > URI** → `DATABASE_URL` として使用
  - 「Display connection pooler」のチェックを **外した** 状態の URI を使用
  - `[YOUR-PASSWORD]` 部分を手順3で設定したパスワードに置き換える
  - 例: `postgresql://postgres.abcdef:パスワード@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres`

#### pgvector 拡張を有効化

Supabase Dashboard で以下を行います:

1. 左メニュー **「Database」** > **「Extensions」** をクリック
2. 検索窓に `vector` と入力
3. **「vector」** を見つけて **トグルを ON** にする

### 3-3. Discord Bot（任意）

Discord Bot を使わない場合はこのステップをスキップしてください。

1. [Discord Developer Portal](https://discord.com/developers/applications) にアクセス
2. **「New Application」** をクリック
3. 名前を入力（例: `DM-AI Bot`）して **「Create」**

#### Bot トークンの取得

1. 左メニュー **「Bot」** をクリック
2. **「Reset Token」** をクリックしてトークンを生成
3. 表示されたトークンをコピーして控えておく → `DISCORD_TOKEN`

#### Client ID の取得

1. 左メニュー **「General Information」** をクリック
2. **「Application ID」** をコピー → `DISCORD_CLIENT_ID`

#### Bot の権限設定

1. 左メニュー **「Bot」** をクリック
2. **Privileged Gateway Intents** セクションで:
   - `MESSAGE CONTENT INTENT` を **ON** にする
3. **「Save Changes」**

#### Bot をサーバーに招待

1. 左メニュー **「OAuth2」** をクリック
2. **「URL Generator」** をクリック
3. **SCOPES** で `bot` と `applications.commands` にチェック
4. **BOT PERMISSIONS** で以下にチェック:
   - `Send Messages`
   - `Embed Links`
   - `Read Message History`
   - `Use Slash Commands`
5. 生成された URL をブラウザで開いて、Bot を招待するサーバーを選択

#### テスト用サーバーの Guild ID を取得

1. Discord の設定 > **詳細設定** > **開発者モード** を **ON**
2. テスト用サーバーのアイコンを右クリック > **「サーバーIDをコピー」**
3. コピーした ID → `DISCORD_GUILD_ID`

---

## 4. 環境変数の設定

### .env ファイルの作成

```bash
cp .env.example .env
```

### .env ファイルの編集

テキストエディタで `.env` を開き、手順3で取得した値を記入します。

```env
# Gemini API (手順 3-1 で取得)
GEMINI_API_KEY=AIzaSyA1B2C3D4E5F6G7H8I9J0...

# Supabase (手順 3-2 で取得)
SUPABASE_URL=https://abcdefghijk.supabase.co
SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIs...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIs...
DATABASE_URL=postgresql://postgres.abcdef:パスワード@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres

# Discord (手順 3-3 で取得、Bot を使わない場合は空欄でOK)
DISCORD_TOKEN=MTIzNDU2Nzg5...
DISCORD_CLIENT_ID=123456789012345678
DISCORD_GUILD_ID=987654321098765432

# 内部API認証 (Bot/管理操作 → API。openssl rand -hex 32 等で生成)
INTERNAL_API_KEY=long_random_string

# Web ログイン用 (値は SUPABASE_URL / SUPABASE_ANON_KEY と同じ)
NEXT_PUBLIC_SUPABASE_URL=https://abcdefghijk.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIs...

# App (変更不要)
API_URL=http://localhost:3001
WEB_URL=http://localhost:3000
NODE_ENV=development
```

> `.env` ファイルは `.gitignore` に含まれているため、Git にはコミットされません。
> API キーなどの秘密情報が漏洩しないよう、絶対に公開しないでください。

---

## 5. データベースの起動と初期化

データベースには **2つの選択肢** があります。

### 選択肢 A: Supabase を使う場合（推奨）

Supabase Dashboard の SQL Editor でテーブルを作成します。

1. Supabase Dashboard にログイン
2. 左メニュー **「SQL Editor」** をクリック
3. **「New query」** をクリック
4. `infra/sql/001_init.sql` の内容を **全文コピー** してエディタに貼り付け
5. **「Run」** をクリック
6. 同様に `infra/sql/002_cards_official_id_unique.sql`、`infra/sql/003_features.sql` も
   この順で貼り付けて実行

`Success. No rows returned` と表示されればOKです。

> 002 は `cards.official_id` を UNIQUE 化します(カード取り込みの UPSERT に必須)。
> 003 は `user_settings` テーブルと重複防止インデックスを追加します。

#### テーブルの確認

1. 左メニュー **「Table Editor」** をクリック
2. 以下の 7 テーブルが表示されていれば成功:
   - `cards`
   - `regulations`
   - `rule_chunks`
   - `decks`
   - `tournament_results`
   - `meta_snapshots`
   - `user_settings`

### 選択肢 B: ローカル Docker を使う場合

```bash
# PostgreSQL + pgvector コンテナを起動
docker compose up db -d
```

起動確認:

```bash
# コンテナの状態を確認
docker compose ps

# db が "running" と表示されればOK
```

> `docker-compose.yml` の設定により、起動時に `001`〜`003` の SQL が自動実行されます。
> ローカル Docker を使う場合、`.env` の `DATABASE_URL` は以下に変更してください:
>
> ```env
> DATABASE_URL=postgresql://postgres:postgres@localhost:5432/dm_ai
> ```

---

## 6. ビルドと動作確認

```bash
# 全パッケージ・全アプリをビルド
pnpm build
```

以下のような出力で **全タスク成功** と表示されればOK:

```
 Tasks:    8 successful, 8 total
Cached:    0 cached, 8 total
  Time:    XX.Xs
```

> エラーが出た場合は [トラブルシューティング](#12-トラブルシューティング) を確認してください。

### テストの実行

```bash
# 単体テスト (DB 不要)
pnpm test

# カバレッジ付き
pnpm test -- --coverage
```

DB を使う統合テストは `TEST_DATABASE_URL` を設定したときのみ実行されます(未設定なら自動スキップ)。
ローカル Docker の場合:

```bash
docker compose up db -d   # 001〜003 が自動適用される
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/dm_ai pnpm test
```

E2E スモーク (Playwright):

```bash
npx playwright install chromium   # 初回のみ (必要に応じて npx playwright install-deps)
pnpm --filter @dm-ai/web e2e
```

---

## 7. データの取り込み

ルール検索やカード検索を動かすには、事前にデータを DB に取り込む必要があります。

### 7-1. ルールPDFの取り込み

公式総合ルールPDFをダウンロード → テキスト抽出 → 条文単位でチャンク化 → 埋め込みベクトル生成 → DB格納 を自動で行います。

```bash
pnpm --filter @dm-ai/worker ingest:rules
```

出力例:

```
=== ルールPDF取り込み開始 ===
PDFダウンロード中: https://dm.takaratomy.co.jp/rule/pdf/dm_comprehensive_rules.pdf
PDFパース中...
ページ数: XX, テキスト長: XXXXX
チャンク化中...
チャンク数: XXX
既存データ削除完了
埋め込み生成中... 1-20/XXX
...
=== ルールPDF取り込み完了: XXXチャンク ===
```

> Gemini API を呼び出すため、`GEMINI_API_KEY` が正しく設定されている必要があります。
> チャンク数にもよりますが、5〜15分程度かかります。

### 7-2. カードデータの取り込み

公式カードDBサイトからカード情報をスクレイピングします。

```bash
pnpm --filter @dm-ai/worker ingest:cards
```

> 公式サイトへのリクエストを送るため、レート制限（1秒間隔）を設けています。
> 全カード（21,000枚超）の取り込みには **数時間** かかります。
> 途中で中断しても、再実行時に差分で取り込まれます。

### 7-3. 殿堂レギュレーションの取り込み

```bash
pnpm --filter @dm-ai/worker ingest:regulations
```

> 数秒で完了します。

### 7-4. カード役割タグの付与

各カードに役割タグ(初動/受け/除去/ドロー/フィニッシャー/メタ/ブースト)を付けます。
まずキーワードルールで判定し、判定できないカードのみ Gemini で推定します。

```bash
# tags が空のカードのみ (デフォルト)
pnpm --filter @dm-ai/worker ingest:tags

# 全カードを対象にする場合
pnpm --filter @dm-ai/worker ingest:tags --all
```

### 7-5. FAQ・裁定の取り込み (任意)

FAQ/裁定ページの本文を RAG(rule_chunks)に取り込み、ルール回答に反映させます。

```bash
pnpm --filter @dm-ai/worker ingest:faq faq <FAQページURL> [URL...]
pnpm --filter @dm-ai/worker ingest:faq ruling <裁定ページURL>
```

### 7-6. メタスナップショットの生成 (任意)

`tournament_results` を期間集計して `meta_snapshots` を作り、ティア表に反映します。
大会結果は `POST /api/meta/ingest/url`(X-Internal-Key 必須)で取り込めます。

```bash
pnpm --filter @dm-ai/worker snapshot:meta original 4
```

### (補正) 既存カード種別の正規化

`ingest:cards` 導入前のデータで種別が日本語のままの場合に実行します。

```bash
pnpm --filter @dm-ai/worker fix:card-types
```

### 取り込み確認

Supabase Dashboard の **Table Editor** で各テーブルにデータが入っていることを確認してください。

| テーブル      | 確認ポイント                                                         |
| ------------- | -------------------------------------------------------------------- |
| `rule_chunks` | ルールPDFのチャンクデータ + `embedding` カラムにベクトルが入っている |
| `cards`       | カード名・コスト・テキスト等が入っている                             |
| `regulations` | 殿堂入り・プレミアム殿堂のカード名が入っている                       |

---

## 8. ローカル開発サーバーの起動

```bash
pnpm dev
```

以下の 2 つのサーバーが同時に起動します:

| アプリ | URL                   | 説明                               |
| ------ | --------------------- | ---------------------------------- |
| Web UI | http://localhost:3000 | ブラウザでアクセスするチャット画面 |
| API    | http://localhost:3001 | バックエンド API サーバー          |

### 動作確認

1. ブラウザで **http://localhost:3000** を開く
2. DM-AI のチャット画面が表示されることを確認
3. 上部のモード切替で **「ルール」** を選択
4. 「S・トリガーとは？」と入力して送信
5. ルール条文を引用した回答が返ってくればOK

### API の動作確認

別のターミナルで以下を実行:

```bash
# ヘルスチェック
curl http://localhost:3001/health
# → {"status":"ok"} と返ればOK

# チャットAPI
curl -X POST http://localhost:3001/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"S・トリガーとは？","mode":"rule"}'

# デッキ評価API（デッキリストのパース）
curl -X POST http://localhost:3001/api/deck/parse \
  -H "Content-Type: application/json" \
  -d '{"decklist":"4 ボルシャック・ドラゴン\n4 ナチュラル・トラップ"}'
```

---

## 9. Discord Bot のセットアップ

手順3-3 で Discord Bot を作成済みであることが前提です。

### 9-1. スラッシュコマンドの登録

Discord にコマンドを登録します。これは **初回1回だけ** 実行すればOKです。

```bash
pnpm --filter @dm-ai/bot deploy-commands
```

出力例:

```
Deploying commands...
Guild commands deployed to 987654321098765432
```

> `DISCORD_GUILD_ID` を設定している場合はそのサーバーのみに即時反映されます。
> 設定していない場合はグローバル登録となり、反映に最大1時間かかります。

### 9-2. Bot の起動

```bash
pnpm --filter @dm-ai/bot dev
```

出力例:

```
Bot ready: DM-AI Bot#1234
```

### 9-3. Discord での動作確認

Bot を招待したサーバーで以下のコマンドを試してください:

```
/dm chat message:デュエル・マスターズについて教えて
/dm rule question:S・トリガーの処理順は？
/dm deck build theme:ボルシャック
/dm meta tier
/dm format set type:オリジナル
```

---

## 10. 本番デプロイ

### 10-1. Web (Vercel)

Next.js の Web UI を Vercel にデプロイします。

1. [Vercel](https://vercel.com/) にログイン
2. **「Import Project」** でこのリポジトリを選択
3. 設定:
   - **Framework Preset**: `Next.js`
   - **Root Directory**: `apps/web`
   - **Build Command**: `cd ../.. && pnpm turbo build --filter=@dm-ai/web`
   - **Install Command**: `cd ../.. && pnpm install`
4. **Environment Variables** に以下を追加:
   - `NEXT_PUBLIC_API_URL` = デプロイ後の API の URL（手順10-2で取得）
5. **「Deploy」** をクリック

### 10-2. API / Bot / Worker (Cloud Run)

Docker イメージをビルドして Google Cloud Run にデプロイします。

#### 前提: gcloud CLI のセットアップ

```bash
# gcloud CLI のインストール（未インストールの場合）
# https://cloud.google.com/sdk/docs/install

# ログイン
gcloud auth login

# プロジェクト設定
gcloud config set project YOUR_PROJECT_ID

# Artifact Registry にリポジトリ作成（初回のみ）
gcloud artifacts repositories create dm-ai \
  --repository-format=docker \
  --location=asia-northeast1

# Docker の認証設定
gcloud auth configure-docker asia-northeast1-docker.pkg.dev
```

#### API のデプロイ

```bash
# Docker イメージのビルド
docker build -f infra/docker/api.Dockerfile -t asia-northeast1-docker.pkg.dev/YOUR_PROJECT_ID/dm-ai/api:latest .

# イメージのプッシュ
docker push asia-northeast1-docker.pkg.dev/YOUR_PROJECT_ID/dm-ai/api:latest

# Cloud Run にデプロイ
gcloud run deploy dm-ai-api \
  --image=asia-northeast1-docker.pkg.dev/YOUR_PROJECT_ID/dm-ai/api:latest \
  --region=asia-northeast1 \
  --port=3001 \
  --allow-unauthenticated \
  --set-env-vars="GEMINI_API_KEY=xxx,SUPABASE_URL=xxx,SUPABASE_ANON_KEY=xxx,DATABASE_URL=xxx"
```

> デプロイ完了後に表示される URL が API のエンドポイントです。
> この URL を Vercel の `NEXT_PUBLIC_API_URL` に設定してください。

#### Bot のデプロイ

```bash
docker build -f infra/docker/bot.Dockerfile -t asia-northeast1-docker.pkg.dev/YOUR_PROJECT_ID/dm-ai/bot:latest .

docker push asia-northeast1-docker.pkg.dev/YOUR_PROJECT_ID/dm-ai/bot:latest

gcloud run deploy dm-ai-bot \
  --image=asia-northeast1-docker.pkg.dev/YOUR_PROJECT_ID/dm-ai/bot:latest \
  --region=asia-northeast1 \
  --no-allow-unauthenticated \
  --min-instances=1 \
  --set-env-vars="DISCORD_TOKEN=xxx,DISCORD_CLIENT_ID=xxx,API_URL=https://dm-ai-api-xxxxx.run.app"
```

> Bot は常時起動が必要なため `--min-instances=1` を指定しています。

#### Worker のデプロイ

Worker はデータ取り込み時のみ実行するため、Cloud Run Jobs を使います。

```bash
docker build -f infra/docker/worker.Dockerfile -t asia-northeast1-docker.pkg.dev/YOUR_PROJECT_ID/dm-ai/worker:latest .

docker push asia-northeast1-docker.pkg.dev/YOUR_PROJECT_ID/dm-ai/worker:latest

# ジョブとして登録
gcloud run jobs create dm-ai-worker-rules \
  --image=asia-northeast1-docker.pkg.dev/YOUR_PROJECT_ID/dm-ai/worker:latest \
  --region=asia-northeast1 \
  --command="node" \
  --args="apps/worker/dist/index.js,rules" \
  --set-env-vars="GEMINI_API_KEY=xxx,DATABASE_URL=xxx"

# 実行
gcloud run jobs execute dm-ai-worker-rules --region=asia-northeast1
```

### 10-3. デプロイ後の環境変数まとめ

| 変数                  | 設定先                  | 値                     |
| --------------------- | ----------------------- | ---------------------- |
| `NEXT_PUBLIC_API_URL` | Vercel (Web)            | Cloud Run API の URL   |
| `GEMINI_API_KEY`      | Cloud Run (API, Worker) | Gemini API キー        |
| `SUPABASE_URL`        | Cloud Run (API)         | Supabase URL           |
| `SUPABASE_ANON_KEY`   | Cloud Run (API)         | Supabase anon key      |
| `DATABASE_URL`        | Cloud Run (API, Worker) | Supabase DB 接続文字列 |
| `DISCORD_TOKEN`       | Cloud Run (Bot)         | Discord Bot トークン   |
| `DISCORD_CLIENT_ID`   | Cloud Run (Bot)         | Discord Application ID |
| `API_URL`             | Cloud Run (Bot)         | Cloud Run API の URL   |

---

## 11. 動作確認チェックリスト

すべてのセットアップが完了したら、以下をチェックしてください。

### ローカル開発

- [ ] `pnpm build` が全タスク成功する
- [ ] `pnpm dev` で Web (3000) と API (3001) が起動する
- [ ] `curl http://localhost:3001/health` が `{"status":"ok"}` を返す
- [ ] ブラウザで http://localhost:3000 にアクセスしてチャット画面が表示される
- [ ] チャットで質問を入力して回答が返ってくる
- [ ] ルール検索で引用付きの回答が返ってくる
- [ ] デッキ評価にデッキリストを入力してスコアが表示される

### データ取り込み

- [ ] `rule_chunks` テーブルにデータが入っている
- [ ] `rule_chunks.embedding` カラムにベクトルが入っている
- [ ] `cards` テーブルにカードデータが入っている
- [ ] `regulations` テーブルに殿堂データが入っている

### Discord Bot（使用する場合）

- [ ] `deploy-commands` が成功する
- [ ] Bot がオンラインになる（Discordでステータスが緑色）
- [ ] `/dm chat` で応答が返ってくる
- [ ] `/dm rule` でルール回答が返ってくる

### 本番デプロイ

- [ ] Vercel で Web がデプロイされてアクセスできる
- [ ] Cloud Run で API がデプロイされてヘルスチェックが通る
- [ ] Web から API に接続できてチャットが動く
- [ ] Discord Bot が本番で応答する

---

## 12. トラブルシューティング

### `pnpm install` が失敗する

```
ERR_PNPM_UNSUPPORTED_ENGINE  Unsupported environment
```

Node.js のバージョンが古い可能性があります。

```bash
node -v  # 20以上であることを確認
nvm install 20 && nvm use 20  # バージョンを切り替え
```

### `pnpm build` で型エラーが出る

```
Cannot find name 'process'
```

`@types/node` がインストールされていない可能性があります。

```bash
pnpm install  # 依存関係を再インストール
pnpm build    # 再ビルド
```

### データベースに接続できない

```
Error: SUPABASE_URL と、SUPABASE_SERVICE_ROLE_KEY または SUPABASE_ANON_KEY が必要です
```

`.env` ファイルが存在し、値が正しく設定されているか確認してください。

```bash
# .env ファイルの存在確認
ls -la .env

# 値が設定されているか確認（キーの値は表示されません）
grep -c "SUPABASE_URL=" .env
```

### Docker でDBが起動しない

```
port 5432 is already in use
```

ローカルに PostgreSQL が既にインストールされている場合、ポートが競合しています。

```bash
# 既存の PostgreSQL を停止するか、docker-compose.yml のポートを変更
# 例: "5433:5432" に変更して DATABASE_URL もポート5433に変更
```

### Worker のルールPDF取り込みが失敗する

```
Error: GEMINI_API_KEY is not set
```

`.env` に `GEMINI_API_KEY` が設定されているか確認してください。

```
Error: PDF download failed: 403
```

公式サイトからのPDFダウンロードがブロックされた可能性があります。ブラウザからPDFを手動ダウンロードして、ローカルパスを指定するように `ingest-rules.ts` を修正してください。

### Discord Bot が応答しない

1. Bot がオンラインか確認（Discord サーバーのメンバー一覧に表示されているか）
2. `DISCORD_TOKEN` が正しいか確認
3. Bot に必要な権限が付与されているか確認（`Send Messages`, `Use Slash Commands`）
4. スラッシュコマンドが登録されているか確認:
   ```bash
   pnpm --filter @dm-ai/bot deploy-commands
   ```

### Gemini API のレート制限エラー

```
Error: 429 Too Many Requests
```

無料枠の API レート制限に達しました。しばらく待ってから再実行してください。
Worker の取り込みジョブでは内部でウェイトを入れていますが、大量のリクエストを送る場合は `BATCH_SIZE` や `DELAY_MS` を調整してください。

### Vercel デプロイでビルドが失敗する

Vercel の設定で以下を確認:

- **Root Directory** が `apps/web` に設定されている
- **Node.js Version** が `20.x` に設定されている
- **Environment Variables** に `NEXT_PUBLIC_API_URL` が設定されている

---

## 補足: 各コンポーネントの個別起動

全体を `pnpm dev` で同時起動するかわりに、個別に起動することもできます。

```bash
# API のみ起動
pnpm --filter @dm-ai/api dev

# Web のみ起動
pnpm --filter @dm-ai/web dev

# Bot のみ起動
pnpm --filter @dm-ai/bot dev

# 特定のワーカージョブを実行
pnpm --filter @dm-ai/worker ingest:rules
pnpm --filter @dm-ai/worker ingest:cards
pnpm --filter @dm-ai/worker ingest:regulations
pnpm --filter @dm-ai/worker ingest:tags
pnpm --filter @dm-ai/worker ingest:faq faq <url>
pnpm --filter @dm-ai/worker snapshot:meta original 4
pnpm --filter @dm-ai/worker fix:card-types
```
