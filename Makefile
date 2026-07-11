# DM-AI 開発用 Makefile
#
# よく使う起動・テスト・データ取り込みを 1 コマンドにまとめたもの。
# 一覧: `make` または `make help`
#
# 前提: Docker (DB 用) と pnpm(9.15.4) がインストール済みであること。
# 環境変数はリポジトリ直下の `.env`(無ければ `make env` で雛形作成)から
# 各コマンドに読み込む。tsx/Next.js は .env を自動ロードしないため、
# この Makefile が実行時に流し込む。

SHELL := /bin/bash
COMPOSE ?= docker compose
DB_URL ?= postgresql://postgres:postgres@localhost:5432/dm_ai

# .env が存在すれば子プロセスへ export して流し込む前置き。
LOAD_ENV := set -a; [ -f .env ] && . ./.env; set +a;

.DEFAULT_GOAL := help
.PHONY: help setup env install \
        db-up db-wait db-down db-reset db-psql \
        dev dev-all dev-web dev-api \
        build typecheck lint test test-watch \
        ingest-rules ingest-cards ingest-regulations ingest-tags ingest-faq \
        snapshot-meta fix-card-types deploy-commands \
        clean down

help: ## このヘルプを表示
	@echo "DM-AI 開発コマンド:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

# ---------- セットアップ ----------
setup: env install ## 初回セットアップ (.env 作成 + 依存インストール)

# .env ファイル本体 (存在しない時だけ .env.example から作成)。
# docker-compose.yml の api/bot が env_file: .env を要求するため、
# .env が無いと `docker compose` 系が全て失敗する。compose を使う
# ターゲットはこの .env を前提条件にして自動生成する。
.env:
	@cp .env.example .env
	@echo "✔ .env を .env.example から作成しました。GEMINI_API_KEY 等のキーを埋めてください。"

env: .env ## .env が無ければ .env.example から作成

install: ## 依存パッケージをインストール
	pnpm install

# ---------- データベース ----------
db-up: .env ## Postgres(pgvector) を起動し接続可能まで待つ
	$(COMPOSE) up -d db
	@$(MAKE) --no-print-directory db-wait

db-wait: .env ## DB が pg_isready になるまで待機
	@echo "waiting for db..."; \
	for i in $$(seq 1 30); do \
		if $(COMPOSE) exec -T db pg_isready -U postgres -d dm_ai >/dev/null 2>&1; then \
			echo "✔ db ready"; exit 0; \
		fi; \
		sleep 1; \
	done; \
	echo "[ERROR] db が起動しませんでした" >&2; exit 1

db-down: .env ## DB を停止 (データは保持)
	$(COMPOSE) stop db

db-reset: .env ## DB を破棄して再作成 (init SQL 001/002/003 を再適用)
	$(COMPOSE) down -v
	@$(MAKE) --no-print-directory db-up

db-psql: .env ## DB に psql で接続
	$(COMPOSE) exec db psql -U postgres -d dm_ai

# ---------- 開発サーバ ----------
dev: db-up ## DB + Web(:3000) + API(:3001) を起動 【通常はこれ】
	$(LOAD_ENV) pnpm turbo dev --filter=@dm-ai/web --filter=@dm-ai/api

dev-all: db-up ## DB + 全アプリ (bot/worker は Discord/各キーが必要)
	$(LOAD_ENV) pnpm dev

dev-web: ## Web(:3000) のみ起動
	$(LOAD_ENV) pnpm --filter @dm-ai/web dev

dev-api: db-up ## DB + API(:3001) のみ起動
	$(LOAD_ENV) pnpm --filter @dm-ai/api dev

# ---------- 品質チェック ----------
build: ## 全パッケージをビルド
	pnpm build

typecheck: ## 型チェック
	pnpm typecheck

lint: ## Lint
	pnpm lint

test: db-up ## 実 DB で全テスト (統合テスト含む)
	TEST_DATABASE_URL=$(DB_URL) pnpm test

test-watch: db-up ## テストを watch モードで実行
	TEST_DATABASE_URL=$(DB_URL) pnpm vitest

# ---------- データ取り込みジョブ (要 GEMINI_API_KEY 等) ----------
# 追加引数は ARGS で渡す。例: make ingest-faq ARGS="faq https://example.com/faq"
ingest-rules: db-up ## 総合ルールを RAG に取り込み
	$(LOAD_ENV) pnpm --filter @dm-ai/worker ingest:rules $(ARGS)

ingest-cards: db-up ## カードマスタを取り込み
	$(LOAD_ENV) pnpm --filter @dm-ai/worker ingest:cards $(ARGS)

ingest-regulations: db-up ## 殿堂レギュレーションを取り込み
	$(LOAD_ENV) pnpm --filter @dm-ai/worker ingest:regulations $(ARGS)

ingest-tags: db-up ## カード役割タグを付与 (ルール→LLM)
	$(LOAD_ENV) pnpm --filter @dm-ai/worker ingest:tags $(ARGS)

ingest-faq: db-up ## FAQ/裁定を RAG に取り込み (ARGS に doc_type と URL)
	$(LOAD_ENV) pnpm --filter @dm-ai/worker ingest:faq $(ARGS)

snapshot-meta: db-up ## 大会結果を集計してメタスナップショット生成
	$(LOAD_ENV) pnpm --filter @dm-ai/worker snapshot:meta $(ARGS)

fix-card-types: db-up ## カードタイプ正規化の補修ジョブ
	$(LOAD_ENV) pnpm --filter @dm-ai/worker fix:card-types $(ARGS)

deploy-commands: ## Discord スラッシュコマンドを登録 (要 Discord キー)
	$(LOAD_ENV) pnpm --filter @dm-ai/bot deploy-commands

# ---------- 後片付け ----------
clean: ## ビルド成果物を削除
	pnpm clean

down: .env ## DB 含むコンテナを全停止
	$(COMPOSE) down
