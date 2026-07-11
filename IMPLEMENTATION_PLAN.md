# DM-AI 機能実装計画書(未実装・プレースホルダー解消)

- 対象リポジトリ: `~/DM-AI`
- 作成日: 2026-07-11
- **前提: `REFACTORING_PLAN.md` の全項目(項目0 + R-01〜R-26 + R-27 ゲート)が適用済みの
  ブランチ `refactor/plan-2026-07` を起点とする**。未適用の場合は先にリファクタリングを完遂すること。
- 本書内でコード位置を「R-XX 適用後」と書いた場合、行番号はリファクタリング適用後の状態を指す。
  行番号は目安であり、引用コード・関数名で位置を特定すること。

---

## 1. 要件とスコープ(オーナー確認済み)

2026-07-11 にオーナーへ確認し、以下が決定している。実行者はこれを覆さないこと。

| 論点 | 決定 |
|---|---|
| スコープ | **A. データパイプライン完成 / B. デッキ機能API完成 / C. Web UIプレースホルダー解消 / D. Discord Bot拡張 — すべて実施** |
| 大会結果の取り込み方式 | **Gemini 汎用抽出**(URL の HTML から構造化抽出。特定サイト非依存) |
| カード役割タグの付与 | **ルール → LLM ハイブリッド**(キーワードルールで大半を付与、判定不能カードのみ Gemini) |
| デッキ保存・認証 | **Supabase Auth 込み**(Web はログイン+ユーザー別デッキ管理まで) |

### 1.1 解消する未実装・プレースホルダー一覧

| # | 現状 | 対応項目 |
|---|---|---|
| 1 | `tournament_results` への書き込み手段が無い(`POST /api/meta/ingest/url` はスタブ) | I-09 |
| 2 | `meta_snapshots` の生成ジョブが無い(ティア表のスナップショット経路が死んでいる) | I-10 |
| 3 | FAQ・裁定の RAG 取り込みが無い(`chunkFaqText`・`doc_type: faq/ruling` が未使用) | I-08 |
| 4 | カードの役割タグ(`cards.tags`)が常に空 → scorer の役割評価・autoBuild のクォータが機能しない | I-06, I-07 |
| 5 | `ingest-cards` がカード種別を日本語のまま格納(`CardType` enum と不整合) | I-05 |
| 6 | `autoBuild` が `format`(殿堂)・`excludeCards`・`civilizations`・`maxCost` を無視 | I-11 |
| 7 | `suggestReplacements` が「簡易版」(`original: ""` のまま入替提案になっていない) | I-12 |
| 8 | `search_cards` の文明/コスト/種別フィルタ・`get_tier_list` の period が未実装(R-15 で宣言を撤去済み) | I-13 |
| 9 | `decks` テーブルが完全に未使用(保存 API も UI も無い) | I-15, I-17, I-19 |
| 10 | 認証が無い(Sidebar の「Guest User / Free Plan」は飾り) | I-14, I-16 |
| 11 | Bot のフォーマット設定が再起動で消える(in-memory Map) | I-18 |
| 12 | Web チャットの「デッキリスト読込/カード検索/裁定確認/Export/Delete」ボタンが飾り | I-20 |
| 13 | meta 画面の Unsplash 仮画像・文明ドット固定・deck 画面の飾りフィルタ・rule 画面の help ボタン | I-21 |

---

## 2. アーキテクチャ設計(全項目共通の前提)

### 2.1 ユーザー ID の規約

`decks.user_id` / `user_settings.user_id`(varchar(100))に格納する ID は必ずプレフィックス付き:

- Web(Supabase Auth): `supabase:<auth.users.id の UUID>`
- Discord Bot: `discord:<Discord ユーザー snowflake>`

両者のアカウント連携(同一人物の紐付け)は**行わない**(§6 参照)。

### 2.2 API 認証の方式(I-14 で実装)

2系統を受け付けるミドルウェアを API に置く:

1. **エンドユーザー(Web)**: `Authorization: Bearer <Supabase アクセストークン>`
   → `getSupabase().auth.getUser(token)` で検証(supabase-js は既に `@dm-ai/db` の依存。
   `getUser(jwt)` は GoTrue の `/user` エンドポイントに問い合わせてトークンを検証する)。
   成功時 `userId = "supabase:" + user.id`。
2. **内部サービス(Bot / 管理操作)**: `X-Internal-Key: <INTERNAL_API_KEY>` +(ユーザー文脈が
   必要な場合)`X-User-Id: discord:<id>`。INTERNAL_API_KEY は環境変数で共有するシークレット。
   キー不一致は 401。**X-User-Id は X-Internal-Key が正しい場合のみ信用する**。

### 2.3 Gemini 構造化出力(I-04 で実装)

`@google/genai` の `generateContent` に
`config: { responseMimeType: "application/json", responseSchema: <OpenAPIサブセット> }`
を渡すと JSON 出力を強制できる(`Type` enum は `@google/genai` から import)。
core に `generateStructured()` を追加し、**戻り値は必ず Zod で再検証**する
(モデル出力を信用しない。Zod 失敗時は1回だけリトライし、それでも失敗なら例外)。

### 2.4 新規テーブル・マイグレーション(I-03)

`infra/sql/003_features.sql`(新規。001/002 は変更しない):

```sql
-- ユーザー設定 (Bot のフォーマット設定永続化。将来 Web 設定にも使う)
CREATE TABLE IF NOT EXISTS user_settings (
  user_id VARCHAR(100) PRIMARY KEY,
  format VARCHAR(20) NOT NULL DEFAULT 'original',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 大会結果の重複取り込み防止 (同一URLの再取り込みを冪等にする)
CREATE UNIQUE INDEX IF NOT EXISTS tournament_results_dedup_uidx
  ON tournament_results (event_name, event_date, deck_archetype, placement);

-- メタスナップショットの期間重複防止 (snapshot:meta ジョブの UPSERT キー)
CREATE UNIQUE INDEX IF NOT EXISTS meta_snapshots_period_uidx
  ON meta_snapshots (format, period_start, period_end);
```

### 2.5 新規依存(この一覧以外の追加は禁止)

| パッケージ | 追加先 | 用途 |
|---|---|---|
| `@vitest/coverage-v8` | ルート devDependencies | カバレッジ計測(I-02)。**必ず `@^3.0.0` を明示指定**(ルートの vitest ^3 とメジャーを揃える。無指定だと v4 系が入り不一致で失敗する) |
| `postgres` | ルート devDependencies | 統合テストハーネスの DB 接続(I-02)。`packages/db` と同じ `^3.4.0` を指定(ワークスペース既存依存の明示化) |
| `cheerio` | packages/rag dependencies | HTML→テキスト抽出 `extractTextFromHtml`(I-08)。`apps/worker` と同じ `^1.0.0` を指定(ワークスペース既存依存の明示化) |
| `@supabase/supabase-js` | apps/web dependencies | Web のログイン(I-16)。バージョンは `packages/db` と同じ `^2.49.0` を指定 |
| `@playwright/test` | apps/web devDependencies | E2E スモーク(I-22) |

### 2.6 新規環境変数(I-01 で .env.example に追記)

```env
# 内部API認証 (Bot/管理操作 → API。ランダムな長い文字列を設定)
INTERNAL_API_KEY=

# Web クライアント用 Supabase (値は SUPABASE_URL / SUPABASE_ANON_KEY と同じ)
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
```

### 2.7 開発プロセス(全項目共通)

オーナーのグローバル方針に従い **TDD を必須**とする:

1. 各項目の「テスト先行」に書かれたテストを**先に書く**(RED を確認)
2. 実装して GREEN にする
3. リファクタして完了条件を確認

- 単体テスト: 純粋関数・アルゴリズム(DB・Gemini はモジュールモックで遮断)
- 統合テスト: `TEST_DATABASE_URL` が設定されている場合のみ実行(ローカル docker の pg を使用。
  I-02 でハーネスを作る)。**CI や DB 無し環境では自動スキップ**され、単体テストだけで green になる
- Gemini 実呼び出しのテストはしない(全てモック)。実呼び出しの確認は各項目の「手動確認」に分離
- 新規作成モジュールの行カバレッジ 80% 以上(I-24 で計測・確認)

---

## 3. 項目0: 安全網(最初に必ず実行)

```bash
cd ~/DM-AI
git switch refactor/plan-2026-07        # リファクタリング完了ブランチ
pnpm install && pnpm build && pnpm typecheck && pnpm test
# 期待: すべて成功 (特性テスト 11件 PASS)。失敗したら中断して報告
git switch -c feature/impl-2026-07
git add IMPLEMENTATION_PLAN.md
git commit -m "docs: 機能実装計画書を追加 (項目0)"
```

以後、**1項目 = 1コミット**。既存の特性テスト(REFACTORING_PLAN.md §2.3)は本計画でも
回帰検知として全項目の完了条件に含まれる。**scorer の特性テストは I-07 でタグデータが入っても
影響を受けない**(DB 無しで実行されるため)。

---

## 4. 作業項目リスト(実行順)

> 各項目の共通完了条件: `pnpm build && pnpm typecheck && pnpm test` 成功(統合テストは
> `TEST_DATABASE_URL` 設定時のみ実行される)。以下では追加条件のみ記す。
> 失敗時の戻し方は全項目共通: `git checkout .` または `git revert <コミット>` → 中断・報告。
>
> curl 確認では別ターミナルで API を起動する。認証系以降(I-14 以降)の確認では
> `INTERNAL_API_KEY=test-key pnpm --filter @dm-ai/api dev` のように必要な env を付けて起動する。

---

## フェーズ0: 基盤

### I-01: 環境変数と .env.example の更新

- **対象**: `.env.example`
- **内容**: §2.6 の3変数を追記する(値は空のまま)。コメントも §2.6 のとおり。
- **テスト先行**: なし(設定ファイルのみ)。
- **完了条件**: 共通条件。`git diff` が .env.example のみ。
- **依存**: 項目0

### I-02: テスト基盤の拡張(カバレッジ + 統合テストハーネス)

- **対象**: ルート `package.json` / `vitest.config.ts`、新規 `tests/helpers/db.ts`
- **内容**:
  1. `pnpm add -D -w @vitest/coverage-v8@^3.0.0`(ルートの vitest ^3.0.0 とメジャーを揃えて明示指定。無指定は禁止 — latest の v4 系が入り provider 不一致で `--coverage` が失敗する)
  2. `vitest.config.ts` を更新:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/**/tests/**/*.test.ts",
      "apps/**/tests/**/*.test.ts",
      "tests/**/*.test.ts",
    ],
    environment: "node",
    env: { DATABASE_URL: "" },
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**", "apps/api/src/**", "apps/worker/src/**"],
      reporter: ["text", "html"],
    },
  },
});
```

  3. 統合テスト用ヘルパー `tests/helpers/db.ts`(リポジトリルート直下 `tests/`):

```ts
import postgres from "postgres";

/** TEST_DATABASE_URL が無ければ null (テストは describe.skipIf で自動スキップ) */
export function getTestSql() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return null;
  return postgres(url, { max: 2 });
}

export const hasTestDb = Boolean(process.env.TEST_DATABASE_URL);

/**
 * 統合テストファイルの beforeAll で必ず呼ぶ:
 * アプリコード (@dm-ai/db の getSql) をテスト DB に接続させる。
 * vitest はテストファイルごとに独立したモジュール環境で実行される (isolate) ため、
 * この env 変更が特性テスト (DATABASE_URL 空の劣化動作前提) に漏れることはない。
 */
export function enableAppDb() {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
}

/** 全テーブルを空にする (各テストファイルの beforeEach で呼ぶ) */
export async function truncateAll(sql: ReturnType<typeof postgres>) {
  await sql`TRUNCATE cards, regulations, rule_chunks, decks,
            tournament_results, meta_snapshots, user_settings RESTART IDENTITY`;
}
```

  統合テストの書き方(以後の項目で共通):

```ts
import { describe, beforeAll, beforeEach, afterAll } from "vitest";
import { closeDb } from "@dm-ai/db";
import { getTestSql, hasTestDb, enableAppDb, truncateAll } from "../../../tests/helpers/db.js";

describe.skipIf(!hasTestDb)("...", () => {
  const sql = getTestSql()!;
  beforeAll(() => enableAppDb());          // アプリコードの getSql() をテストDBへ向ける
  beforeEach(async () => truncateAll(sql));
  afterAll(async () => { await closeDb(); await sql.end(); });
  // fixture INSERT → アプリ関数呼び出し → 検証
});
```

  **重要**: vitest 設定の `env: { DATABASE_URL: "" }` はそのまま維持する
  (既存の特性テストは「DB に接続できない劣化動作」を固定しているため、グローバルに
  DATABASE_URL をブリッジしてはならない。接続が必要な統合テストだけが
  `enableAppDb()` でファイル内ローカルに切り替える)。
  ローカルでの統合テスト実行手順(README 化は I-23):

```bash
docker compose up -d db
docker compose exec -T db psql -U postgres -d dm_ai < infra/sql/002_cards_official_id_unique.sql  # 未適用なら
docker compose exec -T db psql -U postgres -d dm_ai < infra/sql/003_features.sql                   # I-03 以降
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/dm_ai pnpm test
```

  注意: `tests/helpers/db.ts` は `postgres` パッケージを直接参照する
  (`@dm-ai/db` の `getSql` は DATABASE_URL 前提かつ接続をモジュールキャッシュするため
  テストハーネスには不向き)。そのため**ルート devDependencies に `postgres@^3.4.0` を追加する**
  (§2.5 の許可リストに含まれている)。
- **テスト先行**: ハーネス自体の動作確認として `tests/helpers/db.test.ts` を書く
  (`hasTestDb` が false のとき getTestSql() が null / true のとき接続して `SELECT 1` が返る)。
- **完了条件**: 共通条件。`pnpm test -- --coverage` がカバレッジ表を出力して成功。
  `TEST_DATABASE_URL` 未設定で統合テストが skip 表示になること。
- **依存**: 項目0

### I-03: DB マイグレーション 003(user_settings・重複防止インデックス)

- **対象**: 新規 `infra/sql/003_features.sql`、`docker-compose.yml`、`packages/db/src/schema.ts`
- **内容**: §2.4 の SQL を作成。docker-compose の db volumes に 003 のマウント行を追加
  (002 の直後)。`packages/db/src/schema.ts` に `userSettings` テーブル定義を追記
  (drizzle 定義は「型付きドキュメント」として既存テーブルと同様に維持する):

```ts
/** ユーザー設定 */
export const userSettings = pgTable("user_settings", {
  user_id: varchar("user_id", { length: 100 }).primaryKey(),
  format: varchar("format", { length: 20 }).notNull().default("original"),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
});
```

  **注意**: `tournament_results_dedup_uidx` は既存データに重複があると作成に失敗する。
  失敗した場合は中断して報告(手動での重複整理が必要)。
- **テスト先行**: 統合テスト `packages/db/tests/migration.test.ts`(skipIf(!hasTestDb)):
  user_settings への INSERT/SELECT、tournament_results に同一行を2回 INSERT すると
  2回目が unique violation になること。
- **完了条件**: 共通条件。ローカル DB があれば 003 を適用し統合テストが PASS。
  実DB(Supabase)運用中なら「SQL Editor で 003 を実行する」を完了報告に手順として記載。
- **依存**: I-02

### I-04: core に Gemini 構造化出力 `generateStructured` を追加

- **対象**: `packages/core/src/gemini.ts`(追記)、新規 `packages/core/tests/gemini.test.ts`
- **内容**:

```ts
import { z } from "zod";
// 既存 import に Type を追加: import { GoogleGenAI, Type, type Content, type Part } from "@google/genai";

export interface StructuredOptions {
  /** @google/genai の Schema (OpenAPI サブセット。Type enum を使用) */
  responseSchema: Record<string, unknown>;
  systemPrompt?: string;
  temperature?: number;
}

/**
 * JSON 強制出力 + Zod 検証付きの生成。
 * Zod 検証に失敗した場合は1回だけ再試行し、それでも失敗なら例外を投げる。
 */
export async function generateStructured<T>(
  prompt: string,
  zodSchema: z.ZodType<T>,
  options: StructuredOptions
): Promise<T> {
  const client = getClient();
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await client.models.generateContent({
      model: CHAT_MODEL,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        responseMimeType: "application/json",
        responseSchema: options.responseSchema,
        ...(options.systemPrompt ? { systemInstruction: options.systemPrompt } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      },
    });
    const text = response.candidates?.[0]?.content?.parts
      ?.map((p) => p.text ?? "")
      .join("") ?? "";
    try {
      return zodSchema.parse(JSON.parse(text));
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`構造化出力の検証に失敗しました: ${String(lastError)}`);
}
```

- **テスト先行**(`packages/core/tests/gemini.test.ts`。`vi.mock("@google/genai")` で
  `GoogleGenAI` をモックし、`generateContent` の返答を差し替える):
  1. モックが正しい JSON を返す → parse された値が返る
  2. 1回目が不正 JSON、2回目が正しい → リトライして成功(generateContent が2回呼ばれる)
  3. 2回とも Zod 不一致 → 「構造化出力の検証に失敗しました」で reject
  4. `GEMINI_API_KEY` 未設定 → getClient の例外。
     **注意**: gemini.ts はクライアントをモジュール変数にキャッシュするため、このケースは
     `vi.resetModules()` + 動的 `await import("../src/gemini.js")` でモジュールを取り直してから
     実行すること(1〜3 の後にそのまま呼ぶとキャッシュ済みクライアントで例外にならない)
- **完了条件**: 共通条件。新テスト4件 PASS。既存の `chat`/`embed` に変更が無いこと(diff 確認)。
- **リスク**: `@google/genai` ^1.0.0 の `responseSchema` は OpenAPI サブセット形式。
  SDK が `responseJsonSchema`(素の JSON Schema)を受ける版もあるが、本計画では
  `responseSchema` + `Type` enum に統一する。
- **依存**: I-02

---

## フェーズ1: データパイプライン(A)

### I-05: カード種別の正規化(日本語 → CardType enum)

- **対象**: `apps/worker/src/jobs/ingest-cards.ts`、新規 `apps/worker/src/card-type-map.ts`、
  新規 `apps/worker/src/jobs/fix-card-types.ts`、`apps/worker/package.json`(scripts)
- **内容**:
  1. マッピングを純粋モジュールとして切り出す:

```ts
// apps/worker/src/card-type-map.ts
import type { CardType } from "@dm-ai/core";

/** 公式サイト表記 → CardType。前方一致で判定する (「進化クリーチャー」等の派生を吸収) */
const TYPE_PATTERNS: Array<[pattern: RegExp, type: CardType]> = [
  [/スター進化クリーチャー/, "star_evolution_creature"],
  [/クリーチャー/, "creature"],          // 「進化クリーチャー」等もここに落ちる
  [/呪文/, "spell"],
  [/クロスギア/, "cross_gear"],
  [/城/, "castle"],
  [/ウエポン|ウェポン/, "weapon"],
  [/フィールド/, "field"],
  [/タマシード/, "tamaseed"],
];

/** 変換できない場合は null (呼び出し側で warn してスキップ判断) */
export function normalizeCardType(raw: string): CardType | null {
  for (const [pattern, type] of TYPE_PATTERNS) {
    if (pattern.test(raw)) return type;
  }
  return null;
}
```

  2. `scrapeCardDetail` で `type: typeText` を
     `const type = normalizeCardType(typeText);` に変更。null の場合は
     `console.warn(\`未知のカード種別 "${typeText}" のため creature として格納: ${url}\`)` を出して
     `"creature"` にフォールバック(スキップはしない — 種別不明でもカード自体は有用なため)。
  3. 既存データの補正スクリプト `fix-card-types.ts`(scripts に `"fix:card-types"` を追加):
     `SELECT id, type FROM cards` → `normalizeCardType` で変換できた行だけ UPDATE。
     変換不能行は件数と値を console.warn で列挙して残す。
- **テスト先行**: `apps/worker/tests/card-type-map.test.ts`(単体):
  「クリーチャー」→ creature、「進化クリーチャー」→ creature、
  「スター進化クリーチャー」→ star_evolution_creature、「呪文」→ spell、
  「タマシード/クリーチャー」→ **creature**(TYPE_PATTERNS は上から順に評価して最初の
  マッチを返す仕様であり、「クリーチャー」パターンが「タマシード」パターンより先に並んでいるため。
  この順序仕様自体をテストで固定する)、
  「ツインパクト」等の未知表記 → null。
- **完了条件**: 共通条件。新テスト PASS。
- **リスク**: 実サイトの表記バリエーションは網羅できない(フォールバック+warn で運用検知)。
- **依存**: I-02

### I-06: 役割タグ推定ルールエンジン(純粋関数)

- **対象**: 新規 `packages/deck-engine/src/tagger.ts`、`packages/deck-engine/src/index.ts`(export 追加)、
  新規 `packages/deck-engine/tests/tagger.test.ts`
- **内容**: カード1枚から役割タグ(`ROLE_TAGS`: 初動/受け/除去/ドロー/フィニッシャー/メタ/ブースト)を
  推定する**決定的な**純粋関数。ルールは以下で確定(変更する場合はテストも変える):

```ts
import type { Card, RoleTag } from "@dm-ai/core";

/** ルールベースの役割タグ推定。確信が持てるタグのみ返す (0個もあり得る) */
export function inferTagsByRule(card: Card): RoleTag[] {
  const tags = new Set<RoleTag>();
  const text = card.text;

  // 受け: S・トリガー / ブロッカー / S・バック / ニンジャ・ストライク / G・ストライク
  if (
    card.is_shield_trigger ||
    /ブロッカー|S・バック|Ｓ・バック|ニンジャ・ストライク|G・ストライク|Ｇ・ストライク/.test(text)
  ) {
    tags.add("受け");
  }
  // ドロー: 「カードを(N枚)引く」
  if (/カードを(\d+枚)?引/.test(text)) tags.add("ドロー");
  // ブースト: 山札の上からマナゾーンに置く
  if (/山札の上から.{0,10}マナゾーンに置/.test(text)) tags.add("ブースト");
  // 除去: 相手のクリーチャーへの破壊/バウンス/マナ送り/シールド送り/封印
  if (/相手の.{0,30}(破壊する|手札に戻す|マナゾーンに置く|シールド.{0,10}加える|封印)/.test(text)) {
    tags.add("除去");
  }
  // メタ: 行動制約系の文言
  if (/召喚できない|唱えられない|選ばれない|攻撃できない|コストを.{0,6}多く支払う/.test(text)) {
    tags.add("メタ");
  }
  // 初動: コスト3以下で ブースト/ドロー いずれかを持つ
  if (card.cost <= 3 && (tags.has("ブースト") || tags.has("ドロー"))) tags.add("初動");
  // フィニッシャー: コスト6以上かつ (Wブレイカー以上 or パワー9000以上)
  if (
    card.cost >= 6 &&
    (/(W|Ｗ|T|Ｔ|ワールド)・?ブレイカー/.test(text) || (card.power ?? 0) >= 9000)
  ) {
    tags.add("フィニッシャー");
  }
  return [...tags];
}
```

- **テスト先行**(`tagger.test.ts`。カードはインラインのフィクスチャで作る):
  1. S・トリガー持ち呪文 → ["受け"] を含む
  2. 「カードを2枚引く」コスト2 → ドロー+初動
  3. 「山札の上から1枚目をマナゾーンに置く」コスト2 → ブースト+初動
  4. 「相手のクリーチャーを1体選び、破壊する」→ 除去
  5. コスト7・W・ブレイカー → フィニッシャー
  6. 「相手は呪文を唱えられない」→ メタ
  7. バニラ(効果なし・コスト5)→ []
  8. 複合(S・トリガー+破壊)→ 受け と 除去 の両方
- **完了条件**: 共通条件。新テスト8件 PASS。
- **依存**: I-02

### I-07: タグ付与バッチジョブ `ingest:tags`(ルール → LLM フォールバック)

- **対象**: 新規 `apps/worker/src/jobs/ingest-tags.ts`、`apps/worker/src/index.ts`(ジョブ分岐追加)、
  `apps/worker/package.json`(`"ingest:tags": "tsx src/jobs/ingest-tags.ts"`)
- **内容**: 全カード(または `--only-empty` で tags が空のカードのみ。デフォルト --only-empty)を対象に:
  1. `inferTagsByRule` でタグ推定 → 1個以上付けば採用
  2. 0個のカードは 20枚ずつまとめて `generateStructured` に渡し、各カードのタグを推定させる。
     responseSchema は `{ type: Type.ARRAY, items: { type: Type.OBJECT, properties: { name: {type: Type.STRING}, tags: { type: Type.ARRAY, items: { type: Type.STRING, enum: ROLE_TAGS } } } } }`。
     Zod 側は `z.array(z.object({ name: z.string(), tags: z.array(z.enum(ROLE_TAGS)) }))`。
     プロンプトには ROLE_TAGS の定義(各タグの意味)とカード名/コスト/テキスト/パワーを渡す。
     LLM がタグ無しと答えたカードは `[]` のまま。
  3. `UPDATE cards SET tags = ${JSON.stringify(tags)}, updated_at = NOW() WHERE id = ${id}`
  4. バッチ間 `sleep(500)`(レート制限対策。`lib.ts` の sleep を使用)
  5. 終了時にサマリ出力: ルールで付与 N 件 / LLM で付与 M 件 / タグ無し K 件
- **テスト先行**:
  - 単体 `apps/worker/tests/ingest-tags.test.ts`: ジョブ本体から「対象カードを
    ルール適用結果で3分類する」純粋関数 `partitionByRule(cards)` を切り出してテスト
    (rule-tagged / needs-llm の振り分け)。
  - 統合(skipIf(!hasTestDb)): cards に fixture 3枚(ルールで付く1枚・付かない2枚)を INSERT →
    `generateStructured` を vi.mock して固定タグを返す → 実行後 DB の tags を検証。
- **完了条件**: 共通条件。**手動確認**(DB と GEMINI_API_KEY がある環境のみ):
  `pnpm --filter @dm-ai/worker ingest:tags` がサマリを出して正常終了し、
  `SELECT count(*) FROM cards WHERE jsonb_array_length(tags) > 0` が増えること。
- **リスク**: LLM のタグ品質は保証できない(enum 制約+Zod で「不正な値」は防ぐ)。
  scorer の特性テストは DB 無しのため影響なし。
- **依存**: I-04, I-06

### I-08: HTML テキスト抽出 + FAQ・裁定の RAG 取り込みジョブ `ingest:faq`

- **対象**: 新規 `packages/rag/src/html.ts`・`packages/rag/tests/html.test.ts`、
  `packages/rag/src/index.ts`(export 追加)、`packages/rag/package.json`(cheerio 追加)、
  新規 `apps/worker/src/jobs/ingest-faq.ts`、`apps/worker/src/index.ts`、
  `apps/worker/package.json`(`"ingest:faq": "tsx src/jobs/ingest-faq.ts"`)
- **内容**:
  0. **HTML→テキスト抽出は `packages/rag/src/html.ts` に実装する**(I-09 の api 側からも
     使うため。worker 内には置かない):

```ts
import * as cheerio from "cheerio";

/** HTML から本文テキストを抽出する (script/style/nav/header/footer を除去) */
export function extractTextFromHtml(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, nav, header, footer").remove();
  return $("body").text().replace(/\n{3,}/g, "\n\n").trim();
}
```

     `packages/rag/package.json` に `"cheerio": "^1.0.0"` を追加(§2.5 の許可リストどおり)し、
     rag の index.ts から export。`pnpm install` で lockfile 更新をコミットに含める。
  1. ジョブは CLI 引数で doc_type と URL を受け取る:
     `tsx src/jobs/ingest-faq.ts <faq|ruling> <url> [url...]`
     引数検証(doc_type が faq/ruling 以外、URL 0件なら使用法を出して exit 1)
  2. 各 URL: `fetchWithRetry` で HTML 取得 → `extractTextFromHtml`(`@dm-ai/rag` から import)→
     `chunkFaqText` でチャンク化 → チャンク 0 件ならその URL はスキップして warn(既存データは消さない)
  3. チャンクの `meta.url` に取り込み元 URL を設定
  4. 同一 URL の既存チャンクを削除してから挿入(冪等):
     `DELETE FROM rule_chunks WHERE doc_type = ${docType} AND chunk_meta->>'url' = ${url}`
  5. `embed()` でバッチ埋め込み(BATCH_SIZE=20、`ingest-rules.ts` と同じパターン)→ INSERT
     (version には取り込み日 `YYYY-MM-DD` を入れる)
  - 検索側(`searchRules`)は doc_type フィルタ無しで全 doc_type を横断するため、
    **取り込むだけで rule モードの回答に FAQ が混ざるようになる**(コード変更不要)。
- **テスト先行**:
  - 単体 `packages/rag/tests/html.test.ts`: `extractTextFromHtml` に script/style/nav 入りの
    HTML を渡して本文だけが残ること、3連続以上の改行が圧縮されることを検証。
  - `chunkFaqText` は既存テスト済み。
  - 統合(skipIf(!hasTestDb)、`apps/worker/tests/ingest-faq.test.ts`): `@dm-ai/core` の `embed` を
    vi.mock(固定 768 次元ベクトル)し、fetch は `vi.stubGlobal("fetch", vi.fn())` でスタブ →
    実行後 rule_chunks に doc_type='faq'・meta.url 付きで入ること、再実行で件数が増えないこと(冪等)。
- **完了条件**: 共通条件。**手動確認**(任意): 実在の FAQ ページ URL で実行し、
  `POST /api/chat {"message":"<FAQの内容に関する質問>","mode":"rule"}` の citations に反映されること。
- **リスク**: ページ構造によっては本文抽出の質が落ちる(チャンク0件ならスキップされるだけで安全)。
- **依存**: I-02(fetchWithRetry は R-21 で `apps/worker/src/lib.ts` に抽出済み)

### I-09: 大会結果の取り込み `POST /api/meta/ingest/url` 本実装(Gemini 汎用抽出)

- **対象**: `apps/api/src/routes/meta.ts`(スタブ置換)、`packages/core/src/schemas.ts`(スキーマ追記)、
  新規 `apps/api/src/tournament-extract.ts`、新規 `apps/api/tests/ingest-url.test.ts`
- **内容**:
  1. core に追記:

```ts
/** 大会結果ページからの抽出結果 (Gemini 構造化出力の検証用) */
export const TournamentExtractionSchema = z.object({
  event_name: z.string().min(1),
  event_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  participants: z.number().int().positive().nullable(),
  results: z
    .array(
      z.object({
        deck_archetype: z.string().min(1),
        placement: z.number().int().positive(),
      })
    )
    .min(1),
});
export type TournamentExtraction = z.infer<typeof TournamentExtractionSchema>;

/** POST /api/meta/ingest/url リクエスト */
export const IngestUrlRequestSchema = z.object({
  url: z.string().url(),
  format: z.enum(FORMATS).default("original"),
});
```

  2. `apps/api/src/tournament-extract.ts`: HTML を受け取り Gemini で抽出する関数
     (route から分離してテスト可能にする):

```ts
/** HTML テキストから大会結果を構造化抽出する。抽出不能なら例外 */
export async function extractTournament(pageText: string): Promise<TournamentExtraction> {
  return generateStructured(
    `以下はデュエル・マスターズの大会結果ページのテキストです。` +
    `大会名・開催日(YYYY-MM-DD)・参加者数(不明なら null)・` +
    `デッキアーキタイプ名と順位の一覧を抽出してください。\n\n---\n${pageText.slice(0, 30000)}`,
    TournamentExtractionSchema,
    { responseSchema: /* TournamentExtractionSchema に対応する Type ベースの Schema を定義 */, temperature: 0 }
  );
}
```

  3. ルート実装(`/ingest/url`。**X-Internal-Key 必須**(I-14 前なので暫定でこの項目内に
     キー検証を直書きし、I-14 でミドルウェアに置換する):

     - `INTERNAL_API_KEY` 未設定 or ヘッダ不一致 → 401 `{error}`
     - ボディを `IngestUrlRequestSchema` で検証(400)
     - URL fetch(失敗 → 502 `{error: "ページを取得できませんでした"}`)
     - `extractTextFromHtml`(I-08 で `packages/rag/src/html.ts` に実装済み。
       `@dm-ai/rag` から import する — api は既に rag に依存している)
     - `extractTournament` → 失敗は 422 `{error: "大会結果を抽出できませんでした"}`
     - 各 results 行を INSERT: `ON CONFLICT ON CONSTRAINT なし` → 003 の unique index に対し
       `ON CONFLICT (event_name, event_date, deck_archetype, placement) DO NOTHING`
     - 応答: `{ event_name, event_date, inserted: n, skipped: m }`(skipped = conflict 件数)
- **テスト先行**(`apps/api/tests/ingest-url.test.ts`。Hono は `app.request()` でハンドラを
  直接テストできる。`extractTournament` はモジュールモック(vi.mock)、fetch は
  `vi.stubGlobal("fetch", vi.fn())` でスタブする):
  1. X-Internal-Key 無し → 401
  2. ボディ不正(url 無し)→ 400
  3. 正常系: モック抽出結果が DB 挿入用の配列に変換される(統合: skipIf(!hasTestDb) で実 INSERT + 再実行で skipped になる冪等性)
  4. 抽出失敗(モックが throw)→ 422
- **完了条件**: 共通条件。curl 確認(`INTERNAL_API_KEY=test-key` で API 起動):

```bash
curl -s -o /dev/null -w '%{http_code}' -X POST localhost:3001/api/meta/ingest/url \
  -H 'Content-Type: application/json' -d '{"url":"https://example.com"}'          # 401 (キー無し)
curl -s -o /dev/null -w '%{http_code}' -X POST localhost:3001/api/meta/ingest/url \
  -H 'Content-Type: application/json' -H 'X-Internal-Key: test-key' -d '{}'       # 400
```

  **手動確認**(DB + GEMINI_API_KEY がある環境): 実在の大会結果ページ URL で 200 と
  inserted > 0 を確認し、`GET /api/meta/tier` に反映されること。
- **リスク**: 抽出精度はページに依存(Zod で形式は保証、内容の正しさは手動確認)。
  README の記載パスは `/api/ingest/url` だが実体は `/api/meta/ingest/url`(現状どおり)。
  I-23 で README を実体に合わせる。
- **依存**: I-03, I-04, I-08(extractTextFromHtml の配置)

### I-10: メタスナップショット生成ジョブ `snapshot:meta`

- **対象**: `packages/core/src/meta.ts`(新規。集計ロジックの移動先)、
  `apps/api/src/routes/meta.ts`(移動元)、新規 `apps/worker/src/jobs/snapshot-meta.ts`、
  `apps/worker/package.json`(`"snapshot:meta": "tsx src/jobs/snapshot-meta.ts"`)
- **内容**:
  1. R-18 で `apps/api/src/routes/meta.ts` に抽出した `aggregateTierData` を
     `packages/core/src/meta.ts` へ**移動**し(実装は変えない)、core の index.ts から export。
     meta.ts(api)は import に置き換える。TierEntry 相当の戻り値型もここで
     `export interface AggregatedTierEntry { ... }` として命名する。
  2. ジョブ `snapshot-meta.ts`: 引数 `<original|advance> [weeks=4]`:
     - tournament_results を期間(今日から weeks 週間)+format で集計
       (SQL は meta.ts の fallback 集計と同一。`COUNT(*)::int`)
     - 0件なら「対象期間の大会結果がありません」で exit 0(スナップショットは作らない)
     - `aggregateTierData` で tier_data を生成
     - UPSERT: `INSERT ... ON CONFLICT (format, period_start, period_end) DO UPDATE SET tier_data = EXCLUDED.tier_data`
  3. これにより `GET /api/meta/tier` は「スナップショットがあればそれを返す」既存分岐が生きる。
     `win_rate` は算出根拠となるデータ(勝敗)が無いため **null のまま**(§6 参照)。
- **テスト先行**:
  - `aggregateTierData` の移動は既存挙動維持 → core 側に単体テスト新設
    `packages/core/tests/meta.test.ts`(count 比率から Tier1/2/3 判定、usage_rate の丸め)。
  - 統合(skipIf(!hasTestDb)): tournament_results に fixture(10件・2アーキタイプ)を INSERT →
    ジョブ関数を直接呼ぶ → meta_snapshots に1行、tier_data の内容検証、再実行で行数が増えない(UPSERT)。
- **完了条件**: 共通条件。curl 確認(ローカル DB がある場合): ジョブ実行後
  `GET /api/meta/tier?format=original` がスナップショット由来の tier_data を返す。
- **依存**: I-03

---

## フェーズ2: デッキ機能 API(B)

### I-11: autoBuild の制約実装(殿堂・除外・文明・コスト)

- **対象**: `packages/deck-engine/src/builder.ts`、新規 `packages/deck-engine/tests/builder.test.ts`
- **内容**: `autoBuild(theme, format, constraints)` を以下の仕様で完成させる
  (関数シグネチャ・戻り値型 `BuildResult` は変更しない):
  1. **殿堂の分類と必須カード判定は純粋関数に切り出す**(DB 無しでも単体テストできるように。
     新規 `packages/deck-engine/src/regulation-rules.ts`):

```ts
export interface RegulationSets {
  /** プレミアム殿堂 (採用禁止) */
  banned: Set<string>;
  /** 殿堂入り (1枚制限) */
  limited: Set<string>;
}

/** regulations の行を分類する (「プレミアム殿堂コンビ」は autoBuild では制約しない) */
export function classifyRegulations(
  rows: Array<{ card_name: string; restriction_type: string }>
): RegulationSets { /* banned/limited の Set を作る */ }

/** 必須カードに殿堂制約を適用する */
export function applyRegulationToRequired(
  requiredCards: string[],
  reg: RegulationSets
): { adopted: Array<{ name: string; count: number }>; warnings: string[] } {
  // banned → 採用せず warnings に「「X」はプレミアム殿堂のため採用できません」
  // limited → count 1 で採用 / それ以外 → count 4 (MAX_COPIES) で採用
}
```

     autoBuild 冒頭で
     `SELECT card_name, restriction_type FROM regulations WHERE format = ${format}` を取得して
     `classifyRegulations` に渡し、テーマ候補・補充候補の採用時に
     banned はスキップ / limited は count 1 に制限する。
  2. **excludeCards**: テーマ検索・補充クエリの両方で `AND name NOT IN ${sql(excludeCards)}`
     (空配列のときは条件を付けない)
  3. **civilizations**: 指定時、テーマ検索・補充クエリに
     `AND civilizations ?| ${sql.array(constraints.civilizations)}::text[]`
     (jsonb の「いずれかの要素を含む」演算子)。統合テストでこのバインドが動かない場合は
     `?|` の代替として
     `EXISTS (SELECT 1 FROM jsonb_array_elements_text(civilizations) c WHERE c = ANY(${sql.array(civs)}))`
     を使う(**代替側も必ず `sql.array()` でラップする**。素の JS 配列を渡すと
     postgres.js が波括弧なしの文字列にシリアライズし malformed array literal になる)。
  4. **maxCost**: `AND cost <= ${maxCost}`
  5. DB クエリ以外の採用ロジック(役割クォータ・40枚充填)は変更しない。
- **テスト先行**:
  - 単体 `packages/deck-engine/tests/regulation-rules.test.ts`(DB 不要):
    a. classifyRegulations: 3種の restriction_type が banned/limited に正しく分類され、
       「プレミアム殿堂コンビ」はどちらにも入らない
    b. applyRegulationToRequired: banned → 不採用+警告文言 / limited → count 1 /
       通常 → count 4 / 空配列 → 空結果
  - 統合 `packages/deck-engine/tests/builder.test.ts`(skipIf(!hasTestDb)。fixture: カード12枚
    (火/水/自然、コスト帯・タグをばらす)+ regulations 2件(プレミアム殿堂1・殿堂入り1)):
    1. format 指定でプレミアム殿堂カードが結果に含まれない
    2. 殿堂入りカードは count 1 でのみ入る
    3. excludeCards のカードが入らない
    4. civilizations: ["fire"] で水単色カードが入らない(多色の火/水は入ってよい)
    5. maxCost: 5 でコスト6以上が入らない
    6. requiredCards がプレミアム殿堂 → weaknesses に文言、entries に入らない
    7. 制約なし呼び出しの結果が従来と同等(40枚上限・重複なし)
- **完了条件**: 共通条件(単体テストは DB 無しでも PASS)。TEST_DATABASE_URL 環境では
  統合テスト7件 PASS。**DB の無い環境では統合テスト skip のまま完了としてよい**が、
  完了報告に「I-11 統合テスト未実行」と明記すること。
- **リスク**: 中。`?|` 演算子のバインドは postgres.js のバージョン依存があり得る
  (上記の EXISTS 代替をテストで判断)。
- **依存**: I-03(テストハーネス+fixture 運用)、REFACTORING R-19 適用済み(DECK_SIZE 定数)

### I-12: suggestReplacements の本実装(入替提案)

- **対象**: `packages/deck-engine/src/builder.ts`(suggestReplacements 置換)、
  新規 `packages/deck-engine/src/suggest.ts`(純粋ロジック)、
  `packages/deck-engine/tests/suggest.test.ts`
- **内容**: 「何を抜いて何を入れるか」を返す決定的アルゴリズム。DB アクセスと選定ロジックを分離する。

  純粋部(`suggest.ts`):

```ts
export interface SuggestInput {
  /** デッキ内カード (DB で解決済み。未解決カードは tags=[] で渡す) */
  deckCards: Array<{ name: string; count: number; cost: number; tags: string[] }>;
  /** goal ごとの候補カード (DB 検索済み・デッキ外・goal タグ持ち・コスト昇順) */
  candidatesByGoal: Map<string, Array<{ name: string; cost: number; tags: string[] }>>;
}

/**
 * 選定ルール (決定的):
 * 1. 抜く候補 = デッキ内で「どの goal のタグも持たない」カードを、
 *    (a) count が多い順 → (b) cost が高い順 → (c) 名前昇順 で並べる
 * 2. goal を入力順に処理し、各 goal の候補カード先頭から最大2枚を、
 *    抜く候補の先頭から順に 1:1 で対応付ける
 * 3. 抜く候補が尽きたら original は "" ではなく提案自体を打ち切る
 * 4. reason は「『{goal}』強化: {replacement} は {goal} タグ持ち。{original} は目標に寄与しないため入替候補」
 */
export function pickReplacements(input: SuggestInput): Array<{
  original: string;
  replacement: string;
  reason: string;
}> { /* 上記ルールを実装 */ }
```

  DB 部(builder.ts 内の suggestReplacements):
  - deck entries のカード情報を `cards` から一括取得(name IN)
  - goal ごとに候補検索: goal が `ROLE_TAGS` に含まれる場合は
    `EXISTS (SELECT 1 FROM jsonb_array_elements_text(tags) t WHERE t = ${goal})`、
    含まれない自由語の場合は従来どおり `text ILIKE %goal%`。
    いずれも `AND name NOT IN ${sql(deckNames)} ORDER BY cost ASC LIMIT 5`
  - `pickReplacements` に渡して返す(戻り値型は既存と同一)
- **テスト先行**(`suggest.test.ts`、純粋部の単体テスト):
  1. goal タグを持たない高コスト4枚積みカードが最初の original に選ばれる
  2. 全カードが goal に寄与している → 提案 0 件(original:"" を返さない)
  3. 候補が空の goal → その goal からは提案なし
  4. 並び順の決定性(同 count・同 costは名前昇順)
  5. 1 goal あたり最大2提案
- **完了条件**: 共通条件。単体5件 PASS。curl 確認(DB 有り環境のみ):
  `POST /api/deck/suggest` が `original` に実在のデッキ内カード名を返す。
- **依存**: I-06(タグの意味論)、I-07 実施後でないと実データでは候補が出にくい(機能自体は独立)

### I-13: ツールフィルタの実装(search_cards / get_tier_list)

- **対象**: `apps/api/src/routes/chat.ts`(executeToolCall)、`apps/api/src/tools.ts`、
  新規 `apps/api/tests/tools.test.ts`
- **内容**: REFACTORING R-15 で「実装が無いので宣言を削った」パラメータを、**実装した上で宣言を復活**させる。
  1. `search_cards`: `civilization`(CIVILIZATIONS の値)・`max_cost`・`type`(CARD_TYPES の値)を
     SQL に反映。args は Gemini 出力なので**必ず検証してから使う**
     (`z.object({ query: z.string(), civilization: z.enum(CIVILIZATIONS).optional(),
     max_cost: z.number().optional(), type: z.enum(CARD_TYPES).optional() })` を
     ルートファイル内に定義し safeParse。不正なら該当フィルタを黙って無視するのではなく
     `"ツール引数が不正です: ..."` を結果文字列として返す)。
     フィルタ SQL: `AND civilizations ? ${civilization}`(jsonb に要素が含まれる)、
     `AND cost <= ${max_cost}`、`AND type = ${type}`。
  2. `get_tier_list`: `period`(例 "2w")を /tier と同じ規則でパース
     (`parseInt(period.replace("w",""), 10) || 4` 週)し、
     `WHERE format = ${fmt} AND period_end >= ${isoDate(cutoff)}` でスナップショットを絞る。
  3. `tools.ts` の宣言を復活(R-15 の削除をリバートし、description はそのまま)。
- **テスト先行**(`tools.test.ts`): `executeToolCall` を直接呼ぶ。
  - 統合(skipIf(!hasTestDb)): fixture カード投入 → civilization/max_cost/type の各フィルタが効く
  - 単体: args 不正(civilization: "purple")→ エラーメッセージ文字列が返る(throw しない)
- **完了条件**: 共通条件。`git log` に「R-15 の宣言復活」の旨をコミットメッセージで明記。
- **依存**: I-05(type が enum 正規化済みであること)、I-10(get_tier_list の period はスナップショット前提)

---

## フェーズ3: 認証とデッキ保存

### I-14: API 認証ミドルウェア

- **対象**: 新規 `apps/api/src/middleware/auth.ts`、`apps/api/src/index.ts`(適用)、
  `apps/api/src/routes/meta.ts`(I-09 の暫定キー検証をミドルウェアに置換)、
  新規 `apps/api/tests/auth.test.ts`
- **内容**: §2.2 の2系統認証。Hono ミドルウェアとして実装:

```ts
import type { MiddlewareHandler } from "hono";
import { getSupabase } from "@dm-ai/db";

declare module "hono" {
  interface ContextVariableMap {
    userId: string | null;
  }
}

/** 認証を試みて userId を設定する (無認証でも通す) */
export const optionalAuth: MiddlewareHandler = async (c, next) => {
  c.set("userId", null);
  const internalKey = c.req.header("x-internal-key");
  if (internalKey) {
    if (internalKey !== process.env.INTERNAL_API_KEY || !process.env.INTERNAL_API_KEY) {
      return c.json({ error: "内部APIキーが不正です" }, 401);
    }
    c.set("userId", c.req.header("x-user-id") ?? null);
    return next();
  }
  const bearer = c.req.header("authorization");
  if (bearer?.startsWith("Bearer ")) {
    const token = bearer.slice("Bearer ".length);
    const { data, error } = await getSupabase().auth.getUser(token);
    if (error || !data.user) return c.json({ error: "認証に失敗しました" }, 401);
    c.set("userId", `supabase:${data.user.id}`);
  }
  return next();
};

/** 認証必須 (userId が無ければ 401) */
export const requireAuth: MiddlewareHandler = async (c, next) => {
  if (!c.get("userId")) return c.json({ error: "ログインが必要です" }, 401);
  return next();
};
```

  適用: `app.use("*", optionalAuth)` を index.ts の cors の後に追加。
  `requireAuth` は I-15/I-18 の該当ルートで個別適用。
  I-09 の `/ingest/url` は「X-Internal-Key 必須」=
  `if (!c.req.header("x-internal-key")) return 401` + optionalAuth の検証に統一
  (専用の `requireInternal` ミドルウェアを同ファイルに追加してよい。仕様: X-Internal-Key が
  正しくなければ 401)。
- **テスト先行**(`auth.test.ts`。`getSupabase` を vi.mock):
  1. ヘッダ無し → userId null で通過
  2. X-Internal-Key 一致 + X-User-Id → userId が discord:... になる
  3. X-Internal-Key 不一致 → 401
  4. INTERNAL_API_KEY 未設定でキー付きリクエスト → 401(未設定なら常に拒否)
  5. Bearer 有効(モックが user を返す)→ userId = supabase:<id>
  6. Bearer 無効 → 401
  7. requireAuth: userId null → 401
- **完了条件**: 共通条件。既存エンドポイント(chat/deck/meta)が**無認証のまま**使えること
  (curl: `POST /api/deck/evaluate` が従来どおり 200)。
- **リスク**: `getUser` は Supabase への HTTP 呼び出し(1リクエスト+数百ms)。
  本計画ではキャッシュしない(§6)。SUPABASE_URL 未設定環境で Bearer が来た場合は
  getSupabase() が throw → onError で 500 になるが、ローカル無認証運用では Bearer を
  送らないため影響しない。
- **依存**: I-01

### I-15: デッキ保存 CRUD API

- **対象**: `apps/api/src/routes/deck.ts`(追記)、`packages/core/src/schemas.ts`(追記)、
  新規 `apps/api/tests/deck-crud.test.ts`
- **内容**: 以下の4エンドポイント(すべて `requireAuth`):

| メソッド/パス | リクエスト | レスポンス |
|---|---|---|
| `POST /api/deck/save` | `{ title: string(1..100), format, decklist: string }` | 201 `{ id, title, format, cards, scores }` |
| `GET /api/deck/list` | - | 200 `{ decks: [{ id, title, format, overall, created_at }] }`(自分のもののみ、created_at 降順、最大50件) |
| `GET /api/deck/:id` | - | 200 `{ id, title, format, cards, scores, created_at }` / 他人・不存在は 404 |
| `DELETE /api/deck/:id` | - | 200 `{ deleted: true }` / 他人・不存在は 404 |

  - save の処理: `parseDecklist` → entries が 0 件なら 400 → `scoreDeck` を実行し
    `decks (format, title, cards, user_id, scores)` に INSERT(cards = entries、
    scores = DeckScore をそのまま jsonb)。**バリデーション(殿堂)が NG でも保存は許可**
    (下書き保存の用途を妨げない)。
  - core に `DeckSaveRequestSchema` を追記(title/format/decklist。z.string().min(1).max(100))。
  - `:id` は `z.coerce.number().int().positive()` で検証(不正は 404)。
  - 所有チェック: `WHERE id = ${id} AND user_id = ${userId}`(他人のものは存在しない扱い=404)。
- **テスト先行**(`deck-crud.test.ts`。認証はテスト用に
  `X-Internal-Key` + `X-User-Id: discord:test-user` で通す。統合 skipIf(!hasTestDb)):
  1. 無認証で save → 401
  2. save 正常 → 201、DB に user_id 付きで入る、scores.overall が数値
  3. decklist が空/パース不能のみ → 400
  4. list → 自分のデッキのみ・降順
  5. 他人の deck id を GET/DELETE → 404
  6. DELETE 後に GET → 404
- **完了条件**: 共通条件。curl 確認(DB 有り環境、`INTERNAL_API_KEY=test-key`):

```bash
curl -s -X POST localhost:3001/api/deck/save -H 'Content-Type: application/json' \
  -H 'X-Internal-Key: test-key' -H 'X-User-Id: discord:123' \
  -d '{"title":"テスト","format":"original","decklist":"4 テストカード"}'   # 201
curl -s localhost:3001/api/deck/list -H 'X-Internal-Key: test-key' -H 'X-User-Id: discord:123'  # 一覧
```

- **依存**: I-14, I-03

### I-16: Web の Supabase Auth(ログイン UI と API トークン連携)

- **対象**: `apps/web/package.json`(@supabase/supabase-js 追加)、新規 `apps/web/src/lib/supabase.ts`、
  新規 `apps/web/src/components/AuthPanel.tsx`、`apps/web/src/components/Sidebar.tsx`(置換)、
  `apps/web/src/lib/api.ts`(Authorization 付与)
- **内容**:
  1. `lib/supabase.ts`:

```ts
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/** 環境変数が無い場合は null (ログイン機能を無効化して従来どおり動く) */
export const supabase = url && anonKey ? createClient(url, anonKey) : null;
```

  2. `AuthPanel.tsx`(クライアントコンポーネント): Sidebar 下部に置く。
     - `supabase === null` → 何も表示しない(未設定環境では従来 UI から Guest 表示を消すだけ)
     - 未ログイン → メールアドレス+パスワードの小型フォームと「ログイン / 新規登録」ボタン
       (`signInWithPassword` / `signUp`。エラーは赤字表示。signUp 後は
       「確認メールを送信しました(メール確認が有効な場合)」を表示)
     - ログイン済み → メールアドレスと「ログアウト」(`signOut`)
     - `supabase.auth.onAuthStateChange` で表示を同期
  3. `Sidebar.tsx`: 「Guest User / Free Plan」ブロックを `<AuthPanel />` に置換。
     「設定」リンク(href="#")は**削除**(I-21 と整合)。
  4. `lib/api.ts`: `apiPost`/`apiGet` の冒頭で

```ts
async function authHeaders(): Promise<Record<string, string>> {
  if (!supabase) return {};
  const { data } = await supabase.auth.getSession();
  return data.session ? { Authorization: `Bearer ${data.session.access_token}` } : {};
}
```

  を合成してヘッダに付ける(未ログイン時は付けない=既存動作と同一)。
- **テスト先行**: UI の自動テストは I-22(E2E)に委ねる。ここでは
  `apps/web` に単体テスト基盤が無いため **ビルドと手動確認を完了条件にする**
  (vitest の web への導入はスコープ外。§6)。
- **完了条件**: 共通条件 + `pnpm --filter @dm-ai/web build` 成功。
  手動確認: (a) NEXT_PUBLIC_* 未設定で従来どおり表示・動作(AuthPanel 非表示)、
  (b) 設定済み環境でログイン→メール表示→ログアウトが動く。
- **リスク**: 中。Supabase プロジェクト側で Email 認証が有効である前提
  (Supabase のデフォルトで有効)。メール確認 ON のプロジェクトでは signUp 直後は
  セッションが無い(仕様どおりの表示で対応)。
- **依存**: I-14(トークンを受ける API)

### I-17: Web のデッキ保存・マイデッキ UI

- **対象**: `apps/web/src/app/deck/page.tsx`、`apps/web/src/lib/types.ts`(SavedDeck 型追加)
- **内容**:
  1. 評価結果表示中(score があるとき)にタイトル入力+「保存」ボタンを右カラム最下部に追加。
     未ログイン時(supabase なし or セッションなし)は disabled +「ログインすると保存できます」。
     保存成功 → 「保存しました」表示、失敗(401等)→ エラーメッセージ表示。
  2. 左カラム最下部に「マイデッキ」セクション: ログイン時のみ
     `GET /api/deck/list` を取得して一覧(タイトル・overall・日付)。クリックで
     `GET /api/deck/:id` → cards をデッキリストテキストに復元(`{count} {name}` 行形式)して
     入力欄へセット。削除ボタン(confirm → DELETE → 一覧更新)。
  3. `lib/types.ts` に追加:

```ts
export interface SavedDeckSummary {
  id: number;
  title: string;
  format: string;
  overall: number | null;
  created_at: string;
}
```

- **テスト先行**: E2E(I-22)でカバー。単体は無し(§6 の web テスト方針)。
- **完了条件**: 共通条件 + web build 成功。手動確認(API+DB+Supabase 設定済み環境):
  ログイン → 評価 → 保存 → 一覧に出る → クリックで復元 → 削除、の一連が動く。
- **依存**: I-15, I-16

### I-18: Bot のフォーマット設定永続化(user_settings API + Bot 連携)

- **対象**: 新規 `apps/api/src/routes/user.ts`(`/api/user/settings`)、`apps/api/src/index.ts`(route 追加)、
  `apps/bot/src/commands/index.ts`、`packages/core/src/schemas.ts`(スキーマ追記)、
  新規 `apps/api/tests/user-settings.test.ts`
- **内容**:
  1. API(requireAuth。Bot は internal key + X-User-Id で通す):
     - `GET /api/user/settings` → 200 `{ format }`(行が無ければ `{ format: "original" }`)
     - `PUT /api/user/settings` `{ format }`(zod: z.enum(FORMATS))→ UPSERT → 200 `{ format }`
  2. Bot 側(`commands/index.ts`):
     - `apiPost`/`apiGet` に内部認証ヘッダを常時付与:
       `X-Internal-Key: process.env.INTERNAL_API_KEY`、`X-User-Id: discord:${interaction.user.id}`
       → ヘッダ生成を `function internalHeaders(userId: string)` に切り出す。
       INTERNAL_API_KEY 未設定なら起動時に console.warn(設定系コマンドはエラー応答)。
     - `handleFormatSet`: Map 更新に加えて `PUT /api/user/settings` を await(失敗時は
       「設定の保存に失敗しました(次回再起動まで有効)」と返信し in-memory は維持)
     - `handleDeck`/`handleMeta` の format 解決: in-memory Map に無ければ
       `GET /api/user/settings` を1回引いて Map にキャッシュ
- **テスト先行**(`user-settings.test.ts`、統合 skipIf(!hasTestDb)):
  1. 無認証 GET → 401
  2. 初回 GET → original / PUT advance → GET が advance(UPSERT の冪等も)
  3. PUT に不正値 → 400
- **完了条件**: 共通条件。curl 確認は I-15 と同形式。
- **依存**: I-14, I-03

### I-19: Bot の `/dm deck save` コマンド

- **対象**: `apps/bot/src/deploy-commands.ts`(サブコマンド追加)、`apps/bot/src/commands/index.ts`
- **内容**:
  1. deploy-commands の deck グループに追加:
     `save`(options: `list`(required)、`name`(required, max 100))
     ※ REFACTORING §4.2 で deploy-commands 変更を禁止していたのはリファクタ作業の話。
     本計画は機能追加なので変更してよい。**変更後は `pnpm --filter @dm-ai/bot deploy-commands`
     の再実行が必要**(完了報告に明記)。
  2. `handleDeck` に `sub === "save"` 分岐:
     `POST /api/deck/save`(internalHeaders 付き、format はユーザー設定)→
     成功: 「『{name}』を保存しました(スコア: {overall}/100)」の Embed、
     401/失敗: エラーメッセージ返信。
- **テスト先行**: Bot はプロセス起動を伴うため自動テスト対象外(§6)。
  API 側は I-15 でテスト済み。
- **完了条件**: 共通条件。手動確認(Discord 接続環境がある場合のみ):
  `/dm deck save` で保存 Embed が返る。無い場合は typecheck+コードレビューで完了とし、
  完了報告に「Discord 実機未確認」と明記。
- **依存**: I-15, I-18

---

## フェーズ4: Web UI 仕上げ(C)

### I-20: チャット画面の飾りボタンを実装

- **対象**: `apps/web/src/app/page.tsx`
- **内容**(UI の見た目・クラスは変えず、onClick を実装):
  1. **デッキリスト読込**: モーダル(textarea + 「読み込む」)を開き、入力されたリストを
     `「次のデッキを評価してください:\n{リスト}」` として入力欄(input state)へセットして閉じる。
     モーダルは同ファイル内の小コンポーネントでよい(新規ライブラリ禁止)。
  2. **カード検索**: 入力欄に `カード検索: ` を前置してフォーカス(単純なテンプレ挿入)。
  3. **裁定確認**: 同様に `裁定確認: ` を前置。
  4. **Export Chat**(ヘッダ): `messages` を
     `[HH:MM] You/AI: content` 形式のテキストに整形し、Blob + `URL.createObjectURL` で
     `dm-ai-chat-{YYYYMMDD}.txt` をダウンロード。メッセージ 0 件なら disabled。
  5. **Delete Chat**(ヘッダ): `confirm("チャット履歴を削除しますか?")` → `setMessages([])`。
- **テスト先行**: E2E(I-22)で Export/Delete をカバー。単体なし。
- **完了条件**: 共通条件 + web build。手動確認: 5ボタンすべて動作。
- **依存**: 項目0(フェーズ0-3 と独立。ただし実行順はこの位置)

### I-21: meta 画面の仮素材と飾り UI の整理

- **対象**: `apps/web/src/app/meta/page.tsx`、`apps/web/src/app/deck/page.tsx`、
  `apps/web/src/app/rule/page.tsx`、`apps/web/src/lib/format.ts`(関数追加)
- **内容**:
  1. **Unsplash 仮画像を撤去**: `UNSPLASH_IMAGES` 配列と `imageUrl` prop を削除し、
     DeckCard の画像ヘッダをアーキタイプ名から決定的に生成するグラデーションに置換:

```ts
// lib/format.ts に追加
/** 文字列から 0-359 の色相を決定的に得る (アーキタイプのプレースホルダー配色用) */
export function nameToHue(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) % 360;
  return h;
}
```

     DeckCard 側: `style={{ background: \`linear-gradient(135deg, hsl(${hue} 60% 35%), hsl(${(hue + 40) % 360} 60% 20%))\` }}`
  2. **文明ドット(固定の fire 1個)を削除**(`{/* Civilization dots placeholder */}` のブロック)。
     sample_decklist からの文明推定はデータが無いため行わない(§6)。
  3. **deck 画面の文明フィルタボタン(飾り)を削除**(中央カラムヘッダの5ボタン)。
  4. **rule 画面の help ボタン(飾り)を削除**。
- **テスト先行**: なし(見た目の整理)。E2E スモークで画面表示は担保。
- **完了条件**: 共通条件 + web build。`grep -rn "unsplash" apps/web/src` が0件。
  手動確認: meta 画面(データ有り環境ならカード表示、無ければ空表示)が崩れない。
- **依存**: I-16(Sidebar 変更と同時期に UI を触るため、コンフリクト回避で後置)

### I-22: E2E スモークテスト(Playwright)

- **対象**: `apps/web/package.json`(devDep + script)、新規 `apps/web/playwright.config.ts`、
  新規 `apps/web/e2e/smoke.spec.ts`
- **内容**:
  1. `pnpm --filter @dm-ai/web add -D @playwright/test` → `npx playwright install chromium`
  2. config: `webServer` を2つ定義(API: `pnpm --filter @dm-ai/api dev` port 3001 /
     web: `pnpm dev` port 3000。env は DATABASE_URL 等なし=劣化動作)。
     script: `"e2e": "playwright test"`。
  3. スモーク3本(`smoke.spec.ts`):
     - トップ(チャット)が表示され、空入力では送信ボタンが disabled
     - /deck でデッキリスト入力→「評価する」→ 「30/100」(DB無し時の固定スコア)が表示される
     - チャットの Delete Chat が confirm 経由で履歴を空にする(メッセージ0件でも UI が壊れない)
  4. ルートの `pnpm test`(vitest)には**含めない**(ブラウザ依存のため)。
     実行は `pnpm --filter @dm-ai/web e2e` を完了条件・最終ゲートでのみ要求。
- **完了条件**: `pnpm --filter @dm-ai/web e2e` が 3件 PASS(ローカルにブラウザが
  インストールできない環境ではスキップし、完了報告に明記)。
- **依存**: I-20, I-21(UI 確定後)

---

## フェーズ5: 仕上げ

### I-23: ドキュメント更新

- **対象**: `README.md`、`START.md`、`.env.example`(I-01 で更新済みなら確認のみ)
- **内容**(事実と一致させる。宣伝文の追加はしない):
  1. README: API 一覧に追加分(`/api/deck/save|list|:id`、`/api/user/settings`)、
     `POST /api/ingest/url` の記載を実パス `/api/meta/ingest/url` と認証要件付きに修正、
     worker ジョブ一覧に `ingest:tags` / `ingest:faq` / `snapshot:meta` / `fix:card-types` を追加、
     Discord コマンド表に `/dm deck save` を追加、
     技術スタック表の「Next.js 15」を「Next.js 16」に修正(リファクタ計画 §4.5-4 の申し送り)。
  2. START.md: 環境変数節に INTERNAL_API_KEY / NEXT_PUBLIC_* を追記、
     003_features.sql の適用手順、統合テストの実行手順(I-02 のコマンド)、
     データ取り込み節に新ジョブの実行例を追記。
- **完了条件**: 記載したコマンドを上から実際に実行して全て動くこと(ドキュメントの実行検証)。
- **依存**: I-01〜I-22 完了後

### I-24: 最終ゲート

```bash
pnpm install                                   # lockfile clean
pnpm build && pnpm typecheck && pnpm test      # 全部成功
pnpm test -- --coverage                        # 新規モジュールのカバレッジ確認 (下記)
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/dm_ai pnpm test  # 統合含め成功 (docker db 起動時)
pnpm --filter @dm-ai/web e2e                   # E2E 3件 (実行可能な環境で)
git status                                     # clean
```

カバレッジ確認対象(**新規作成モジュールが行 80% 以上**であること。満たさない場合は
テストを追加してから完了とする):
`packages/deck-engine/src/tagger.ts`、`packages/deck-engine/src/suggest.ts`、
`packages/core/src/meta.ts`、`packages/core/src/gemini.ts`(generateStructured 部)、
`apps/worker/src/card-type-map.ts`、`apps/api/src/middleware/auth.ts`、
`apps/api/src/tournament-extract.ts`

手動スモーク(DB/Gemini/Supabase が揃った環境がある場合):
取り込み(cards → tags → regulations → rules → faq → ingest/url → snapshot:meta)を順に流し、
Web で「ログイン → チャット → デッキ評価 → 保存 → マイデッキ → ティア表」を一巡する。

---

## 5. 実行順とフェーズ間依存(サマリ)

```
フェーズ0: I-01 → I-02 → I-03 → I-04
フェーズ1: I-05, I-06 (並行可) → I-07 / I-08 → I-09 → I-10
フェーズ2: I-11, I-12, I-13 (I-13 は I-05/I-10 の後)
フェーズ3: I-14 → I-15 → I-16 → I-17 / I-18 → I-19
フェーズ4: I-20 → I-21 → I-22
フェーズ5: I-23 → I-24
```

「並行可」とあっても実施は1項目ずつ(1項目=1コミット)。順序はこのリストのとおりでよい。

---

## 6. やらないことリスト

- **アカウント連携**: Discord ユーザーと Supabase ユーザーの紐付け・統合はしない(ID は §2.1 の2系統のまま)。
- **プラン・課金**: 「Free Plan」表記は削除するのみ。プラン管理・決済は作らない。
- **RLS(Row Level Security)**: 認可は API 層で行う。Supabase 側の RLS 設定・`@supabase/ssr` の導入・サーバーコンポーネントでの認証はしない。
- **win_rate の算出**: 大会結果に勝敗数が無いため null のまま。UI の "--" 表示も変えない。
- **レート制限・入力サイズ上限**: 今回も対象外(既知の課題として引き継ぐ。公開運用前に必須)。
- **auth.getUser のキャッシュ**: 毎リクエスト検証のまま(性能課題が出たら別途)。
- **advance フォーマットの殿堂取り込み**: ingest-regulations は original のみのまま(公式ページの advance 側の構造が未検証のため)。
- **effective_from の実日付取得**: 固定日付のまま(ソース未確定)。
- **web への vitest 導入・コンポーネント単体テスト**: web の自動テストは E2E スモーク3本のみ。
- **UI デザインの変更**: 既存のスタイル・レイアウトは維持(I-20/I-21 は onClick 実装と仮素材撤去のみ)。
- **新規依存の追加**: §2.5 の3つ+ルート devDeps の `postgres`(I-02)以外は追加禁止。バージョン更新も禁止。
- **REFACTORING_PLAN.md 適用結果の変更**: リファクタ済みコードの再リファクタはしない(R-15 の宣言復活など、本計画に明記した箇所を除く)。
- **CI の構築**: GitHub Actions 等は作らない。

---

## 7. 実行者への指示文

以下をそのままコピーして実行 AI に渡すこと。

```
あなたは ~/DM-AI リポジトリの機能実装の実行者です。
リポジトリ直下の IMPLEMENTATION_PLAN.md が唯一の作業指示書です(前提として
REFACTORING_PLAN.md が適用済みのブランチ refactor/plan-2026-07 から始めます)。
以下のルールを厳守してください。

1. まず IMPLEMENTATION_PLAN.md を最後まで読むこと。§1(要件)と §6(やらないこと)が
   スコープの境界です。§2(設計)の規約(ユーザーID形式・認証方式・新規依存の許可リスト)に
   従ってください。
2. §3(項目0)を最初に実行し、ベースラインが green であることを確認すること。
   失敗したら作業せず報告。
3. 作業項目 I-01〜I-24 を記載順に、1項目ずつ実施すること。1項目=1コミット。
   コミットメッセージは「<type>: <要約> (I-XX)」形式(type: feat / test / chore / docs)。
4. 各項目は TDD で進めること: 「テスト先行」に書かれたテストを先に書いて RED を確認してから
   実装する。テストが書けない項目(UI・設定)は項目内の完了条件に従う。
5. 完了条件(共通: pnpm build && pnpm typecheck && pnpm test、および項目の追加条件)を
   すべて満たしてからコミット。満たせない場合は変更を破棄して中断・報告。
   完了条件を満たすためにテストを弱めることは禁止。
6. 統合テストは TEST_DATABASE_URL 設定時のみ動く設計です。ローカルで docker が使えるなら
   docker compose up -d db + 003 適用で統合テストも回すこと。使えない環境では単体テストのみで
   進め、完了報告に「統合テスト未実行の項目」を列挙すること。
7. Gemini・Supabase・Discord の実呼び出しが必要な「手動確認」は、環境(APIキー等)が
   ある場合のみ実施。無い場合はスキップして報告に明記(テストのモックで代替済み)。
8. §6(やらないこと)に該当する変更は、改善に見えても行わないこと。計画とコードが
   食い違って判断できない場合は中断して報告。
9. 全項目完了後に I-24(最終ゲート)を実行し、以下を含む完了報告を書くこと:
   - 各項目の結果一覧(コミットハッシュ付き)
   - 統合テスト/手動確認/E2E の実施状況(未実施はその理由)
   - 新規モジュールのカバレッジ表
   - 気づいたが §6 に従って手を付けなかった事項
10. main へのマージ・プッシュはせず、feature/impl-2026-07 ブランチに残して終了すること。
```
