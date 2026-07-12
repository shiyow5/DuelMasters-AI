# DM-AI リファクタリング計画書

- 対象リポジトリ: `~/DM-AI` (ベースコミット: `082dde9` / ブランチ `main`)
- 作成日: 2026-07-11
- 性質: **リファクタリングのみ**。機能追加・仕様変更・依存ライブラリのバージョン更新は行わない
  (例外は本文中に明示。テスト基盤 vitest の新規導入と、バグと断定した箇所の挙動修正のみ)。
- 本計画書のベースライン検証: 2026-07-11 時点で `pnpm install` / `pnpm build`(全8ワークスペース)/
  `pnpm typecheck`(7パッケージ)がすべて成功することを実機確認済み。
  特性テストの期待値(§2.3)もすべて実機で採取した実測値である。

---

## 1. 現状理解

### 1.1 システム概要

デュエル・マスターズ(トレーディングカードゲーム)特化の Q&A ボット。4つの機能を持つ:

1. **ルール確認**: 公式総合ルール PDF を RAG(キーワード+ベクトルのハイブリッド検索)で検索し、Gemini が条文引用付きで回答
2. **デッキ構築支援**: テキスト形式デッキリストの解析・スコアリング(100点満点)・殿堂レギュレーションチェック・テーマ指定自動構築
3. **環境分析**: 大会結果 DB からのティアリスト集計
4. **統合チャット**: Gemini Function Calling で上記機能をツールとして自動実行

技術スタック: TypeScript / pnpm 9.15.4 + Turborepo / Node 22 / Hono(API) / Next.js(Web) /
discord.js(Bot) / PostgreSQL + pgvector(Supabase または docker-compose のローカル pg) /
`@google/genai`(Gemini 2.5 Flash Lite + gemini-embedding-001, 768次元)。

### 1.2 パッケージ構造と依存関係

```
apps/web (Next.js UI)          apps/bot (Discord Bot)
      │ HTTP (fetch)                 │ HTTP (fetch)
      └──────────┬──────────────────┘
                 ▼
          apps/api (Hono, port 3001)
                 │
   ┌─────────────┼──────────────────┐
   ▼             ▼                  ▼
@dm-ai/rag   @dm-ai/deck-engine   @dm-ai/core (chat/embed/型/定数)
   │             │                  ▲
   └──────┬──────┘                  │ (型・定数参照)
          ▼                         │
      @dm-ai/db (getSql) ───────────┘

apps/worker (取り込みジョブ) ──▶ @dm-ai/core, @dm-ai/db, @dm-ai/rag
```

重要な事実:

- **apps/web はワークスペースパッケージに一切依存しない**(HTTP 経由のみ)。そのため web 内に
  API レスポンス型のコピーが存在する(後述の作業項目で web 内ローカル lib に集約するが、
  `@dm-ai/core` への依存追加は行わない。Next.js の transpile 設定追加が必要になりリスクが高いため)。
- **`@dm-ai/db` から実際に使われているのは `getSql`(生SQLクライアント)と `closeDb` のみ**。
  `getDb`(Drizzle)・`getSupabase`・`schema.ts` の Drizzle テーブル定義は現状どこからも呼ばれて
  いない(将来用と思われるため削除しない。§4 参照)。

### 1.3 主要ファイルの役割

| ファイル                                     | 行数    | 役割                                                                                                                                    |
| -------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/constants.ts`             | 82      | フォーマット・文明・カード種別等の定数、`DECK_SIZE=40`、`MAX_COPIES=4`、`DECK_GUIDELINES`(評価目安値)                                   |
| `packages/core/src/schemas.ts`               | 198     | Zod スキーマ(Card/Deck/Regulation/RuleChunk/DeckScore 等)。**現状、実行時バリデーションには一切使われておらず型の供給源としてのみ機能** |
| `packages/core/src/gemini.ts`                | 129     | Gemini クライアント(遅延初期化)。`chat()`(Function Calling対応)と `embed()`/`embedSingle()`                                             |
| `packages/db/src/client.ts`                  | 58      | `getSupabase`/`getDb`(Drizzle)/`getSql`(postgres.js)/`closeDb`。全て遅延初期化・モジュール変数キャッシュ                                |
| `packages/db/src/schema.ts`                  | 168     | Drizzle テーブル定義(未使用)+ pgvector 用 customType                                                                                    |
| `packages/rag/src/chunker.ts`                | 119     | ルール PDF テキストの条文単位チャンク化(`chunkRuleText`)、FAQ 分割、サイズ分割                                                          |
| `packages/rag/src/search.ts`                 | 143     | ハイブリッド検索 `searchRules`(キーワード LIKE + pgvector cosine、スコアマージ)                                                         |
| `packages/deck-engine/src/parser.ts`         | 61      | デッキリストのテキストパース(`4 カード名` / `カード名 x4` 等4形式)                                                                      |
| `packages/deck-engine/src/validator.ts`      | 86      | 枚数・同名制限・殿堂チェック(DB接続不可時は警告を出してスキップ)                                                                        |
| `packages/deck-engine/src/scorer.ts`         | 223     | デッキ評価(トリガー数/多色/コストカーブ/文明/初動率/役割 → 100点満点)。DB接続不可時は「全カード情報なし」として評価続行                 |
| `packages/deck-engine/src/builder.ts`        | 172     | テーマ検索ベースの自動構築 `autoBuild` と改善提案 `suggestReplacements`(`format` 引数と `constraints` の大半は**未実装で無視される**)   |
| `apps/api/src/index.ts`                      | 36      | Hono 起動、CORS、/health                                                                                                                |
| `apps/api/src/routes/chat.ts`                | 206     | チャット本体。モード別システムプロンプト、ツール実行ループ(`executeToolCall`)、rule モードの RAG 付加                                   |
| `apps/api/src/routes/deck.ts`                | 73      | /parse /evaluate /build /suggest                                                                                                        |
| `apps/api/src/routes/meta.ts`                | 151     | /tier(スナップショット→無ければ大会結果から集計、Tier閾値 15%/8%)、/archetype/:name、/ingest/url(未実装スタブ)                          |
| `apps/api/src/tools.ts`                      | 99      | Gemini Function Calling のツール定義(6種)                                                                                               |
| `apps/bot/src/commands/index.ts`             | 257     | 全スラッシュコマンドのハンドラ+API クライアント(`apiPost`/`apiGet`)                                                                     |
| `apps/bot/src/deploy-commands.ts`            | 134     | コマンド定義の Discord 登録スクリプト                                                                                                   |
| `apps/worker/src/jobs/ingest-rules.ts`       | 95      | ルールPDF → pdf-parse → チャンク化 → embed → rule_chunks 格納                                                                           |
| `apps/worker/src/jobs/ingest-cards.ts`       | 201     | 公式カードDBスクレイピング → cards upsert(**ON CONFLICT が現状動かない。R-04 参照**)                                                    |
| `apps/worker/src/jobs/ingest-regulations.ts` | 66      | 殿堂ページスクレイピング → regulations 全削除→再投入                                                                                    |
| `apps/web/src/app/page.tsx` ほか4ページ      | 281-510 | チャット/ルール/デッキ/メタの各画面(クライアントコンポーネント)                                                                         |
| `apps/web/src/lib/api.ts`                    | 33      | fetch ラッパー(bot 側にほぼ同一の複製あり)                                                                                              |
| `infra/sql/001_init.sql`                     | 104     | 全テーブル DDL(docker-compose 起動時に自動適用)                                                                                         |

### 1.4 データフロー(代表2つ)

**デッキ評価** (`POST /api/deck/evaluate`):
`web/bot → deck.ts → parseDecklist → [scoreDeck, validateRegulation] (並列) → JSON応答`。
scoreDeck は `cards` テーブルからカード情報を取得(現状カード名ごとに1クエリの N+1)。
DB が無くても両関数とも例外を握りつぶして劣化動作する(**この劣化動作が特性テストの土台**)。

**統合チャット** (`POST /api/chat`, mode=integrated):
`chat.ts → Gemini(chat, tools付き) → toolCalls があれば executeToolCall で実行 →
結果を添えて Gemini に再問い合わせ → 応答`。mode=rule の場合はツールの代わりに
`searchRules` の結果をコンテキストとして付加し、citations を返す。

### 1.5 実行・ビルド方法

```bash
pnpm install          # 依存インストール (pnpm が無ければ: npx pnpm@9.15.4 install)
pnpm build            # turbo build (全8ワークスペース。packages → apps の順に解決)
pnpm typecheck        # turbo typecheck (^build 依存あり。web は typecheck スクリプト無し=next build が型検査を兼ねる)
pnpm --filter @dm-ai/api dev    # API 起動 (port 3001)。環境変数なしでも起動し /health は 200 を返す
docker compose up -d db         # ローカル pg16+pgvector。001_init.sql が初回に自動適用
```

### 1.6 既知の癖(実行者が誤解しやすい点)

1. **`.env` は自動では読み込まれない**。コードに dotenv は無く、docker-compose の `env_file` か
   シェルでの手動 export 頼み。→ 特性テストは「DATABASE_URL が無い」状態を前提にできる。
2. **typecheck は各パッケージの `dist/` に依存**する(workspace 参照が `dist/index.d.ts` を向く)。
   必ずルートの `pnpm typecheck`(turbo が依存を先にビルド)を使うこと。
   パッケージ単体で `tsc --noEmit` を直接叩くと古い dist を参照して誤判定することがある。
3. **エラー握りつぶしによる劣化動作は一部が意図的な設計**(DB 無しでもデモできる)。
   本計画では「劣化動作は維持しつつ、ログだけ出す」方針で統一する(挙動レベルでは互換)。
4. **git 追跡状況**: `tmp-ui/`(UIモックHTML+スクリーンショット約2.7MB)が追跡されている。
   `.next/` `dist/` `node_modules/` は .gitignore 済み。コミットは `082dde9` の1つだけ。
5. **テストは1本も存在しない**(テストランナー未導入)。→ 項目0で導入する。
6. Bot のユーザー別フォーマット設定(`userFormats`)はプロセス内 Map であり再起動で消える(仕様)。

---

## 2. 項目0: 安全網の構築(最初に必ず実行)

### 2.1 作業ブランチとベースラインコミット

```bash
cd ~/DM-AI
git status              # 期待: REFACTORING_PLAN.md (未追跡) 以外に変更がないこと。他に差分があれば中断して報告
git switch -c refactor/plan-2026-07   # main は動かさない
git add REFACTORING_PLAN.md
git commit -m "docs: リファクタリング計画書を追加 (項目0)"
```

以後、**全作業をこのブランチで行い、1項目=1コミット**とする。

### 2.2 ベースライン確認

```bash
pnpm install    # 期待: エラーなく完了 (lockfile 変更なし)
pnpm build      # 期待: 8ワークスペースすべて成功 (exit 0)
pnpm typecheck  # 期待: 7パッケージすべて成功 (exit 0)
```

3コマンドのいずれかが失敗した場合は**作業を開始せず**、失敗ログを添えて報告すること
(計画作成時点では全て成功している)。

### 2.3 特性テストの導入(vitest + テスト4ファイル)

テストが存在しないため、リファクタリング対象の中核ロジック(純粋関数+DB無し劣化動作)を
**現状の実測出力**で固定する。以下の期待値はすべて 2026-07-11 に実機で採取したものであり、
テストが RED になった場合は「実装を変えてしまった」ことを意味する(テスト側を疑わないこと。
ただし R-09 のみ意図的な挙動変更があり、その項目内で影響の有無を明記している)。

#### (a) vitest の導入

ルート `package.json` の `devDependencies` に vitest を追加し、`scripts` に test を追加:

```jsonc
// package.json (ルート) — 差分のみ
{
  "scripts": {
    // 既存はそのまま、以下を追加
    "test": "vitest run",
  },
  "devDependencies": {
    "turbo": "^2.4.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0", // 追加。これが本計画で唯一許可される新規依存
  },
}
```

ルートに `vitest.config.ts` を新規作成:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/tests/**/*.test.ts"],
    environment: "node",
    // DB 未接続時の劣化動作を固定するため、DATABASE_URL を強制的に空にする
    env: { DATABASE_URL: "" },
  },
});
```

```bash
pnpm install   # vitest が入る (lockfile 更新はこのコミットに含める)
```

注意: テストは各パッケージの `tests/` に置く(`src/` 外なので tsc のビルド対象にならず、
既存ビルドへ影響しない)。テスト内の import は `../src/xxx.js` 形式(実装と同じ拡張子付き
ESM 形式。vitest はこれを TS ソースに解決できる)。`@dm-ai/core` 等のワークスペース参照は
ビルド済み `dist/` に解決されるため、**テスト実行前に必ず `pnpm build` を行う**こと。

#### (b) テストコード全文

`packages/deck-engine/tests/parser.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseDecklist } from "../src/parser.js";

describe("parseDecklist 特性テスト", () => {
  it("『4 カード名』形式", () => {
    expect(parseDecklist("4 ボルシャック・ドラゴン")).toEqual({
      entries: [{ count: 4, name: "ボルシャック・ドラゴン" }],
      totalCards: 4,
      errors: [],
    });
  });

  it("混在形式・コメント・空行", () => {
    const input = [
      "ボルシャック・ドラゴン x4",
      "ナチュラル・トラップ ×3",
      "2x フェアリー・ライフ",
      "# コメント",
      "// コメント2",
      "",
      "デーモン・ハンド",
    ].join("\n");
    expect(parseDecklist(input)).toEqual({
      entries: [
        { count: 4, name: "ボルシャック・ドラゴン" },
        { count: 3, name: "ナチュラル・トラップ" },
        { count: 2, name: "フェアリー・ライフ" },
        { count: 1, name: "デーモン・ハンド" },
      ],
      totalCards: 10,
      errors: [],
    });
  });

  it("数字のみの行はエラー", () => {
    expect(parseDecklist("42")).toEqual({
      entries: [],
      totalCards: 0,
      errors: ['パースできない行: "42"'],
    });
  });

  it("空文字列", () => {
    expect(parseDecklist("")).toEqual({ entries: [], totalCards: 0, errors: [] });
  });
});
```

`packages/deck-engine/tests/validator.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseDecklist } from "../src/parser.js";
import { validateRegulation } from "../src/validator.js";

// DATABASE_URL 無しで実行される前提 (vitest.config.ts で強制)。
// 殿堂チェックはスキップされ、固定の警告文が返る。
const DB_SKIP_WARNING = "殿堂データベースに接続できないため、殿堂チェックをスキップしました";

function list(n: number, prefix = "カード"): string {
  const lines: string[] = [];
  let rest = n;
  let i = 1;
  while (rest > 0) {
    const c = Math.min(4, rest);
    lines.push(`${c} ${prefix}${i}`);
    rest -= c;
    i++;
  }
  return lines.join("\n");
}

describe("validateRegulation 特性テスト (DB無し)", () => {
  it("40枚ちょうどは valid", async () => {
    const deck = parseDecklist(list(40));
    expect(await validateRegulation(deck, "original")).toEqual({
      valid: true,
      errors: [],
      warnings: [DB_SKIP_WARNING],
    });
  });

  it("39枚は枚数エラー", async () => {
    const deck = parseDecklist(list(39));
    expect(await validateRegulation(deck, "original")).toEqual({
      valid: false,
      errors: ["デッキは40枚ちょうどである必要があります (現在: 39枚)"],
      warnings: [DB_SKIP_WARNING],
    });
  });

  it("同名5枚は上限エラー (合計40枚)", async () => {
    const deck = parseDecklist("5 過剰カード\n" + list(35, "カードX"));
    expect(await validateRegulation(deck, "original")).toEqual({
      valid: false,
      errors: ["「過剰カード」は最大4枚までです (現在: 5枚)"],
      warnings: [DB_SKIP_WARNING],
    });
  });
});
```

`packages/deck-engine/tests/scorer.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseDecklist } from "../src/parser.js";
import { scoreDeck } from "../src/scorer.js";

describe("scoreDeck 特性テスト (DB無し = 全カード情報なしの劣化動作)", () => {
  it("40枚デッキ・カード情報なし", async () => {
    const deck = parseDecklist(
      Array.from({ length: 10 }, (_, i) => `4 テストカード${i + 1}`).join("\n"),
    );
    const score = await scoreDeck(deck);
    expect(score).toEqual({
      triggerCount: 0,
      rainbowCount: 0,
      costCurve: { low: 0, mid: 0, high: 0 },
      civilizationBalance: {},
      openingHandRate: 0,
      roleBalance: {},
      overall: 30,
      warnings: [
        "S・トリガーが0枚です (推奨: 8枚以上)",
        "低コスト(3以下)が0枚です (推奨: 15枚)",
        "受け札が少なく、攻撃に弱い構成です",
      ],
      suggestions: [
        "S・トリガー持ちのカードを追加して防御力を上げましょう",
        "初動で使える低コストカードを増やしましょう",
        "S・トリガーやブロッカーなどの受け札を追加しましょう",
        "ドローソースを増やしてリソース確保を安定させましょう",
      ],
    });
  });
});
```

`packages/rag/tests/chunker.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { chunkRuleText, chunkFaqText, chunkBySize } from "../src/chunker.js";

describe("chunker 特性テスト", () => {
  it("chunkRuleText: セクション・条文単位の分割", () => {
    const rule = [
      "100. セクションA",
      "100.1. 条文1本文",
      "続きの行",
      "100.2a. 条文2本文",
      "101. セクションB",
      "セクション本文",
    ].join("\n");
    // 注意: R-03 実施後は第2・第3引数が無くなるため、その項目内の指示に従い
    // 呼び出しを chunkRuleText(rule) に変更する。期待値は変わらない。
    expect(chunkRuleText(rule, "comprehensive_rules", "1.49")).toEqual([
      { text: "100. セクションA", meta: { section: "100" } },
      { text: "100.1. 条文1本文\n続きの行", meta: { section: "100", article: "100.1" } },
      { text: "100.2a. 条文2本文", meta: { section: "100", article: "100.2a" } },
      { text: "101. セクションB\nセクション本文", meta: { section: "101" } },
    ]);
  });

  it("chunkFaqText: Q単位分割・10文字未満は捨てる", () => {
    const faq =
      "Q: 質問その1ですか？ A: 回答その1です。\nQ: 質問その2ですか？ A: 回答その2です。\nQ:短い";
    expect(chunkFaqText(faq)).toEqual([
      { text: "Q: 質問その1ですか？ A: 回答その1です。", meta: {} },
      { text: "Q: 質問その2ですか？ A: 回答その2です。", meta: {} },
    ]);
  });

  it("chunkBySize: サイズ分割とオーバーラップ", () => {
    const text = "あ".repeat(30) + "。" + "い".repeat(30) + "。" + "う".repeat(30) + "。";
    expect(chunkBySize(text, 40, 5)).toEqual([
      { text: "あ".repeat(30) + "。", meta: {} },
      { text: "ああああ。" + "い".repeat(30) + "。", meta: {} },
      { text: "いいいい。" + "う".repeat(30) + "。", meta: {} },
    ]);
  });
});
```

#### (c) 完了条件

```bash
pnpm build && pnpm test
# 期待: 4ファイル・11テストすべて PASS
git add -A && git commit -m "test: リファクタリング用の特性テストを追加 (vitest導入)"
```

以後、**すべての作業項目の完了条件に `pnpm build && pnpm typecheck && pnpm test` の成功を含む**
(項目内で個別に追加条件を記載)。

---

## 3. 作業項目リスト(実行順)

> 記載凡例 — **対象**: ファイルパス:行範囲(**ベースコミット時点の行番号**。先行項目で同一ファイルを
> 変更した場合はずれるため、行番号は目安とし、引用したコードで位置を特定すること)/ **問題** /
> **変更** / **完了条件**(コマンドと期待結果)/ **リスク** / **依存**(先に完了すべき項目)。
> **戻し方は全項目共通**: 完了条件を満たせない場合は `git checkout .`(未コミットなら)または
> `git revert <該当コミット>` で戻し、中断して報告する。個別の注意がある場合のみ項目内に記す。
>
> 共通完了条件(全項目): `pnpm build && pnpm typecheck && pnpm test` がすべて成功すること。
> 以下の各項目には追加の完了条件のみ記載する。
>
> API に対する curl 確認が完了条件にある項目では、別ターミナルで
> `env -u GEMINI_API_KEY -u DATABASE_URL pnpm --filter @dm-ai/api dev` を起動しておくこと
> (環境変数なしで起動でき、`curl -s http://localhost:3001/health` が `{"status":"ok"}` を返す)。
> 確認後は Ctrl+C で停止する。

---

### R-01: tmp-ui/(UIモック置き場)を git 管理から削除

- **対象**: `tmp-ui/` ディレクトリ全体(HTMLモック4点+PNG13点、約2.7MB)
- **問題**: 開発初期のUIモックとスクリーンショットがリポジトリに追跡されている。コードから一切参照されていない(grep で参照ゼロを確認済み)。
- **変更**: `git rm -r tmp-ui` で削除する。他のファイルには触れない。
- **完了条件**: `git status` で tmp-ui の削除のみがステージされていること。`ls tmp-ui` が「No such file or directory」。共通完了条件。
- **リスク**: なし(git 履歴に残るため必要になれば復元可能)。
- **依存**: 項目0

### R-02: packages/rag の未使用依存 pdf-parse を削除

- **対象**: `packages/rag/package.json:21,25`
- **問題**: `pdf-parse` と `@types/pdf-parse` が dependencies/devDependencies に宣言されているが、`packages/rag/src/` のどのファイルも import していない(PDF パースは apps/worker 側の責務で、worker は自前で pdf-parse を持っている)。
- **変更**: `packages/rag/package.json` から `"pdf-parse": "^1.1.1"`(dependencies)と `"@types/pdf-parse": "^1.1.4"`(devDependencies)の2行を削除し、`pnpm install` で lockfile を更新する。
- **完了条件**: `grep -rn "pdf-parse" packages/rag/src/ packages/rag/package.json` が0件。`pnpm-lock.yaml` の更新はこのコミットに含める。共通完了条件。
- **リスク**: なし(コードが import していないため)。apps/worker 側の pdf-parse には触れないこと。
- **依存**: 項目0

### R-03: chunkRuleText の未使用引数 docType / version を削除

- **対象**: `packages/rag/src/chunker.ts:17-21`、呼び出し元 `apps/worker/src/jobs/ingest-rules.ts:34`、テスト `packages/rag/tests/chunker.test.ts`
- **問題**: `chunkRuleText(fullText, docType, version)` の第2・第3引数が関数本体で一度も参照されていない(doc_type と version は呼び出し元が DB 挿入時に別途使っている)。使われない引数はシグネチャの嘘であり、将来の読み手を誤解させる。
- **変更**:

```ts
// packages/rag/src/chunker.ts — 変更前
export function chunkRuleText(
  fullText: string,
  docType: DocType,
  version: string
): Chunk[] {

// 変更後 (import type { DocType } from "@dm-ai/core"; も不要になるため削除)
export function chunkRuleText(fullText: string): Chunk[] {
```

```ts
// apps/worker/src/jobs/ingest-rules.ts:34 — 変更前
const chunks = chunkRuleText(parsed.text, "comprehensive_rules", VERSION);
// 変更後
const chunks = chunkRuleText(parsed.text);
```

テスト `chunker.test.ts` の呼び出しも `chunkRuleText(rule)` に変更する(期待値は変更しない)。

- **完了条件**: 共通完了条件(テスト11件 PASS のまま)。
- **リスク**: 低。呼び出し元は ingest-rules.ts とテストの2箇所のみ(grep で確認済み)。
- **依存**: 項目0

### R-04: cards.official_id の UNIQUE 欠如で ingest-cards の ON CONFLICT が実行時エラーになる問題の修正

- **対象**: `infra/sql/001_init.sql:27`(参照のみ・変更しない)、`packages/db/src/schema.ts:65`、`apps/worker/src/jobs/ingest-cards.ts:115`、`docker-compose.yml:29-31`
- **問題**: `upsertCard` が `ON CONFLICT (official_id) DO UPDATE` を使っているが、DB には official_id の**非UNIQUEインデックスしか無い**。PostgreSQL は ON CONFLICT の対象に UNIQUE 制約/インデックスを要求するため、**カード1枚目の INSERT 時点で必ず SQLSTATE 42P10 エラーになり、取り込みジョブは現状一度も成功し得ない**。さらに official_id が取れない URL では `?? ""` により空文字が入るため、UNIQUE 化すると空文字同士が衝突する。
- **変更**: 以下の4点をこの1コミットで行う。

  (1) 新規ファイル `infra/sql/002_cards_official_id_unique.sql`:

```sql
-- cards.official_id を UNIQUE 化する (ingest-cards の ON CONFLICT (official_id) を機能させる)
-- 注意: 既存データに official_id の重複行がある場合は失敗する。その場合は重複行を手動で
-- 整理してから再実行すること。NULL は UNIQUE インデックスでは重複とみなされない。
DROP INDEX IF EXISTS cards_official_id_idx;
CREATE UNIQUE INDEX IF NOT EXISTS cards_official_id_uidx ON cards (official_id);
```

(2) `docker-compose.yml` の db サービスの volumes に追記(001 の直後の行):

```yaml
- ./infra/sql/002_cards_official_id_unique.sql:/docker-entrypoint-initdb.d/002_cards_official_id_unique.sql
```

(3) `packages/db/src/schema.ts` — インデックス定義を UNIQUE に合わせる:

```ts
// 変更前 (65行目付近)
    index("cards_official_id_idx").on(table.official_id),
// 変更後 (ファイル冒頭の import に uniqueIndex を追加すること)
    uniqueIndex("cards_official_id_uidx").on(table.official_id),
```

(4) `apps/worker/src/jobs/ingest-cards.ts` — official_id が空のカードは取り込みをスキップする
(空文字のまま UNIQUE 化すると全ての「ID不明カード」が1行に上書き合成されてしまうため):

```ts
// 変更前 (115行目)
const officialId = new URL(url).searchParams.get("id") ?? "";
// 変更後
const officialId = new URL(url).searchParams.get("id");
if (!officialId) {
  console.warn(`official_id が取得できないためスキップ: ${url}`);
  return null;
}
```

- **完了条件**: 共通完了条件。加えてローカルDBで適用確認(Docker が使える場合のみ。使えない場合はスキップ可):

```bash
docker compose up -d db && sleep 5
docker compose exec -T db psql -U postgres -d dm_ai < infra/sql/002_cards_official_id_unique.sql
docker compose exec db psql -U postgres -d dm_ai -c '\d cards' | grep official_id
# 期待: "cards_official_id_uidx" UNIQUE, btree (official_id) が表示される
```

- **リスク**: 中。**稼働中の実DB(Supabase等)がある場合、002 の SQL を手動適用するまで取り込みジョブは修正前と同じくエラーになる**(適用手順は上記 psql と同じ。Supabase なら SQL Editor で 002 を実行)。既存 DB に official_id 重複データがあると 002 が失敗する — その場合は中断して報告。
- **依存**: 項目0

### R-05: rag/search.ts の sql.unsafe + 文字列連結クエリをパラメタライズドクエリへ書き換え

- **対象**: `packages/rag/src/search.ts:43-103, 140-143`
- **問題**: 検索クエリを `sql.unsafe()` + 文字列連結で組み立てており、ユーザー入力(検索キーワード・docType)の防御が自作の `escapeSql`(シングルクォート置換のみ)頼みになっている。さらに `searchByKeyword` の `match_count` は `conditions.map(() => "1").join(" + ")` により **定数 "1 + 1 + …"(=常にキーワード数)を SELECT しているだけ**で、実際のマッチ数を数えておらず、キーワード検索の順位付けが機能していない(全ヒット行が同点)。
- **変更**: `searchByKeyword` / `searchByVector` を postgres.js のパラメータバインドとフラグメント合成で書き換え、`escapeSql` を削除する。match_count は実際のマッチ数を数えるよう修正する(**バグ修正としての挙動変更**: キーワード検索の順位付けが「多くのキーワードにマッチした行ほど上位」になる。スコア計算式 `(match_count / keywords.length) * 0.5` 自体は不変)。

```ts
/** キーワード検索 (ILIKE ベース) */
async function searchByKeyword(
  sql: ReturnType<typeof getSql>,
  query: string,
  topK: number,
  docType?: string,
): Promise<ChunkResult[]> {
  const keywords = query
    .split(/[\s　、。,.]/)
    .filter((k) => k.length > 0)
    .slice(0, 5);

  if (keywords.length === 0) return [];

  const patterns = keywords.map((k) => `%${k}%`);
  const matchExpr = patterns
    .map((p) => sql`(chunk_text ILIKE ${p})::int`)
    .reduce((acc, frag) => sql`${acc} + ${frag}`);
  const whereExpr = patterns
    .map((p) => sql`chunk_text ILIKE ${p}`)
    .reduce((acc, frag) => sql`${acc} OR ${frag}`);

  const rows = await sql`
    SELECT id, chunk_text, chunk_meta,
           (${matchExpr}) AS match_count
    FROM rule_chunks
    WHERE (${whereExpr}) ${docType ? sql`AND doc_type = ${docType}` : sql``}
    ORDER BY match_count DESC
    LIMIT ${topK}
  `;

  return rows.map((row: Record<string, unknown>) => ({
    id: row.id as number,
    text: row.chunk_text as string,
    score: (Number(row.match_count) / keywords.length) * 0.5,
    meta: (row.chunk_meta as Record<string, unknown>) ?? {},
  }));
}

/** ベクトル検索 (cosine similarity) */
async function searchByVector(
  sql: ReturnType<typeof getSql>,
  query: string,
  topK: number,
  docType?: string,
): Promise<ChunkResult[]> {
  const embedding = await embedSingle(query);
  const vecParam = `[${embedding.join(",")}]`;

  const rows = await sql`
    SELECT id, chunk_text, chunk_meta,
           1 - (embedding <=> ${vecParam}::vector) AS similarity
    FROM rule_chunks
    WHERE embedding IS NOT NULL ${docType ? sql`AND doc_type = ${docType}` : sql``}
    ORDER BY embedding <=> ${vecParam}::vector
    LIMIT ${topK}
  `;

  return rows.map((row: Record<string, unknown>) => ({
    id: row.id as number,
    text: row.chunk_text as string,
    score: row.similarity as number,
    meta: (row.chunk_meta as Record<string, unknown>) ?? {},
  }));
}
```

ファイル末尾の `escapeSql` 関数(140-143行)は削除する。`searchRules` と `mergeResults` は変更しない。

- **完了条件**: 共通完了条件。加えて `grep -n "unsafe\|escapeSql" packages/rag/src/search.ts` が0件。
- **リスク**: 中。この関数は DB 接続がないと実行確認できない(Gemini の embedding も必要)。
  実行時の最終確認は本項目では行わず、コード上の同値性(SELECT 対象・WHERE 条件・ORDER・LIMIT が
  変更前と同一構造であること)を目視で確認する。DB がある環境なら
  `mode=rule` のチャット(`POST /api/chat {"message":"S・トリガーとは","mode":"rule"}`)で応答が返ることを確認するとよい。
- **依存**: 項目0

### R-06: db/client.ts の接続リークとエラーメッセージ不正確の修正

- **対象**: `packages/db/src/client.ts:11-47`
- **問題**: (1) `getSql()` を先に呼んだ後に `getDb()` を呼ぶと、`getDb` が新しい `postgres()` 接続を生成して `_sql` を上書きし、元の接続がリークする(getDb は現状未使用のため実害は潜在的だが、将来の呼び出しで発火する地雷)。(2) `getSupabase` のエラーメッセージが「SUPABASE_URL and SUPABASE_ANON_KEY are required」だが、実際は SERVICE_ROLE_KEY でも可。
- **変更**:

```ts
// 変更前 (25-35行)
export function getDb(): PostgresJsDatabase<typeof schema> {
  if (!_db) {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required");
    }
    _sql = postgres(databaseUrl);
    _db = drizzle(_sql, { schema });
  }
  return _db;
}

// 変更後 (getSql を再利用して二重接続を防ぐ)
export function getDb(): PostgresJsDatabase<typeof schema> {
  if (!_db) {
    _db = drizzle(getSql(), { schema });
  }
  return _db;
}
```

注意: `getDb` の定義位置を `getSql` の後に移動する必要はない(hoisting される関数宣言のため)。
エラーメッセージは以下に変更:

```ts
// 変更前 (17行)
throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY are required");
// 変更後
throw new Error("SUPABASE_URL と、SUPABASE_SERVICE_ROLE_KEY または SUPABASE_ANON_KEY が必要です");
```

- **完了条件**: 共通完了条件。
- **リスク**: 低(getDb/getSupabase はリポジトリ内で未使用のため挙動影響なし)。
- **依存**: 項目0

### R-07: ingest-regulations の「全 format 削除」「空取得時の全消去」「宣言位置」の修正

- **対象**: `apps/worker/src/jobs/ingest-regulations.ts:28-61`
- **問題**: (1) 取り込むのは `format: "original"` の行だけなのに `DELETE FROM regulations` が **format を問わず全行削除**する(advance のデータが存在した場合、実行のたびに消える)。(2) スクレイピングが0件でも(サイト構造変更・セレクタ不一致で普通に起こる)そのまま DELETE が走り、**既存データが全消去されて空になる**。(3) `regulations` 配列が main() より後のモジュールレベル(57-61行)で宣言されており、コードを上から読むと未定義参照に見える。(4) effective_from の固定日付 `'2024-01-01'` が INSERT 文に直値で埋まっている。
- **変更**: main() を以下の形に修正する(パース部・ログ文言は変更しない):

```ts
/** 施行日はスクレイピング元から取得していない (既知の制限。仕様変更はしない) */
const EFFECTIVE_FROM = "2024-01-01";

async function main() {
  console.log("=== 殿堂レギュレーション取り込み開始 ===");

  const res = await fetch(REGULATION_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);

  const sql = getSql();

  const sections = [
    { selector: ".premium-dendou", type: "プレミアム殿堂" },
    { selector: ".dendou", type: "殿堂入り" },
    { selector: ".premium-combi", type: "プレミアム殿堂コンビ" },
  ];

  const regulations: Array<{
    format: string;
    restriction_type: string;
    card_name: string;
  }> = [];

  for (const section of sections) {
    $(section.selector)
      .find("li, .card-name, tr")
      .each((_, el) => {
        const cardName = $(el).text().trim();
        if (!cardName || cardName.length > 100) return;
        regulations.push({
          format: "original",
          restriction_type: section.type,
          card_name: cardName,
        });
      });
  }

  if (regulations.length === 0) {
    throw new Error(
      "殿堂レギュレーションを1件も取得できませんでした。ページ構造が変わった可能性があります。既存データは変更せず中断します",
    );
  }

  // original のみ入れ替える (他 format のデータは保持)
  await sql`DELETE FROM regulations WHERE format = 'original'`;

  let count = 0;
  for (const reg of regulations) {
    await sql`
      INSERT INTO regulations (format, restriction_type, card_name, effective_from)
      VALUES (${reg.format}, ${reg.restriction_type}, ${reg.card_name}, ${EFFECTIVE_FROM})
    `;
    count++;
  }

  console.log(`=== 殿堂レギュレーション取り込み完了: ${count}件 ===`);
  await closeDb();
}
```

末尾のモジュールレベル `const regulations` 宣言(57-61行)は削除する。`main().catch(...)` は変更しない。

- **完了条件**: 共通完了条件(このジョブは DB とサイトが必要なため実行確認はしない。目視で「DELETE に WHERE format = 'original' が付いたこと」「0件時に DELETE 前で throw すること」を確認)。
- **リスク**: 低。**挙動変更(バグ修正)**: 0件時に DB を消さず異常終了するようになる。advance の既存行が保持されるようになる。
- **依存**: 項目0

### R-08: scorer.ts fetchCardInfo の N+1 クエリ解消とエラーの可視化

- **対象**: `packages/deck-engine/src/scorer.ts:127-166`
- **問題**: (1) ユニークなカード名ごとに `SELECT ... WHERE name = x LIMIT 1` を直列で発行しており、40枚デッキで10〜20回のDBラウンドトリップが発生する(N+1)。(2) catch が完全に空で、DB 障害でも「全カードがDBに未登録」と同じ結果になり、原因が一切ログに残らない。
- **変更**: 1回の `WHERE name IN` クエリにまとめ、catch に警告ログを追加する。**出力(返り値)は完全に同一に保つこと**(特性テスト scorer.test.ts が守る)。

```ts
/** カード情報をDBから一括取得 */
async function fetchCardInfo(names: string[]): Promise<Map<string, Card>> {
  const map = new Map<string, Card>();
  const uniqueNames = [...new Set(names)];
  if (uniqueNames.length === 0) return map;

  try {
    const sql = getSql();
    const rows = await sql`
      SELECT * FROM cards WHERE name IN ${sql(uniqueNames)}
    `;
    for (const row of rows) {
      const name = row.name as string;
      if (map.has(name)) continue; // 同名複数行は最初の1行を採用 (変更前の LIMIT 1 相当)
      map.set(name, {
        name,
        civilizations: (row.civilizations ?? []) as Card["civilizations"],
        cost: (row.cost as number) ?? 0,
        type: (row.type ?? "creature") as Card["type"],
        races: (row.races as string[]) ?? [],
        text: (row.text as string) ?? "",
        power: (row.power as number) ?? null,
        is_rainbow: (row.is_rainbow as boolean) ?? false,
        is_shield_trigger: (row.is_shield_trigger as boolean) ?? false,
        tags: ((row.tags as string[]) ?? []) as Card["tags"],
        card_image_url: (row.card_image_url as string) ?? null,
        official_id: (row.official_id as string) ?? null,
        set_code: (row.set_code as string) ?? null,
        rarity: (row.rarity as string) ?? null,
      });
    }
  } catch (err) {
    // DB未接続時はカード情報なしで評価を続行する (劣化動作は仕様として維持)
    console.warn(
      "カード情報の取得に失敗したため、カード情報なしで評価します:",
      err instanceof Error ? err.message : err,
    );
  }

  return map;
}
```

- **完了条件**: 共通完了条件。特に `pnpm test` の scorer.test.ts が**変更なしで** PASS すること
  (console.warn がテスト出力に出るのは正常)。
- **リスク**: 低。同名カードが DB に複数行ある場合、変更前の `LIMIT 1`(順序未指定)と同様に
  どの行が選ばれるかは非決定的であり、その性質は変わらない。
- **依存**: 項目0

### R-09: scorer.ts の警告閾値と DECK_GUIDELINES の不整合解消・直値の定数化

- **対象**: `packages/deck-engine/src/scorer.ts:58-63, 84, 184-222`
- **問題**: (1) 低コスト警告の発火条件が直値 `< 10` なのに、警告文言は `DECK_GUIDELINES.costCurve.low`(=15)を「推奨」として表示しており、**「推奨: 15枚」と言いながら10枚以上あれば警告しない**という矛盾がある(README の評価指標表は15枚を目安と明記)。(2) `calculateOverallScore` 内に 40 / 8 / 15 / 10 / 5 / 0.7 などの直値が散在し、core の `DECK_SIZE`・`DECK_GUIDELINES` と二重管理になっている。(3) 手札枚数 `5` が直値。
- **変更**: **挙動変更を1点だけ含む(バグ修正)**: 低コスト警告・ペナルティの閾値を `DECK_GUIDELINES.costCurve.low`(15)に統一する。これにより low が 10〜14 枚のデッキで新たに警告+10点減点が発生する。**特性テスト scorer.test.ts は low=0 のケースのため影響なし(期待値変更不要)**。

  変更点一覧:

```ts
// import に DECK_SIZE を追加
import { DECK_SIZE, DECK_GUIDELINES, type DeckScore } from "@dm-ai/core";

// ファイル冒頭 (import 直後) に内部閾値を定数化して集約
/** scoreDeck 内部のスコアリング閾値 (DECK_GUIDELINES に無い減点基準) */
const HAND_SIZE = 5;                       // 初手枚数
const OPENING_RATE_TARGET = 0.7;           // 初動率の合格ライン
const TRIGGER_SEVERE_THRESHOLD = 6;        // トリガー大幅不足の閾値
const LOW_COST_SEVERE_THRESHOLD = 5;       // 低コスト大幅不足の閾値
const MULTI_CIV_WARN_THRESHOLD = 4;        // 色事故警告の文明数
const MULTI_CIV_SEVERE_THRESHOLD = 5;      // 色事故追加減点の文明数
const MIN_DEFENSE_CARDS = 4;               // 受け札の最低目安
const MIN_DRAW_CARDS = 4;                  // ドロー札の最低目安

// 58行目: 変更前
  if (costCurve.low < 10) {
// 変更後 (文言は既に DECK_GUIDELINES を参照しているため変更不要)
  if (costCurve.low < DECK_GUIDELINES.costCurve.low) {

// 75行目: if (civCount >= 4) → if (civCount >= MULTI_CIV_WARN_THRESHOLD)
// 84行目: calculateOpeningRate(earlyCards, deck.totalCards, 5) → (…, HAND_SIZE)
// 94行目: < 4 → < MIN_DEFENSE_CARDS / 99行目: < 4 → < MIN_DRAW_CARDS

// calculateOverallScore 内 (196-219行):
  if (params.totalCards !== DECK_SIZE) score -= 20;                       // 40 → DECK_SIZE
  if (params.triggerCount < TRIGGER_SEVERE_THRESHOLD) score -= 15;        // 6
  else if (params.triggerCount < DECK_GUIDELINES.triggerCount) score -= 5; // 8
  if (params.rainbowCount > DECK_GUIDELINES.rainbowMax) score -= 10;      // 15
  if (params.costCurve.low < DECK_GUIDELINES.costCurve.low) score -= 10;  // 10 → 15 (挙動変更)
  if (params.costCurve.low < LOW_COST_SEVERE_THRESHOLD) score -= 10;      // 5
  if (params.civCount >= MULTI_CIV_WARN_THRESHOLD) score -= 10;           // 4
  if (params.civCount >= MULTI_CIV_SEVERE_THRESHOLD) score -= 5;          // 5
  if (params.openingHandRate < OPENING_RATE_TARGET) score -= 10;          // 0.7
```

減点幅の数値(20/15/5/10/…)は変更しない。役割バランスの減点(受け0で-15、フィニッシャー0で-10)も数値は変更しない。

- **完了条件**: 共通完了条件。**scorer.test.ts が期待値の変更なしで PASS** すること(low=0 は新旧どちらの閾値でも警告・減点対象のため)。
- **リスク**: 低〜中。low が10〜14枚のデッキのスコアと警告が変わる(意図した修正)。web/bot は
  スコアを表示するだけなので追随修正は不要。
- **依存**: 項目0

### R-10: core に API リクエスト用 Zod スキーマを追加(検証の準備)

- **対象**: `packages/core/src/schemas.ts`(末尾に追記)
- **問題**: API ルートは `c.req.json<T>()` の型注釈だけで実行時検証をしていない。core に Zod スキーマ群が既にあるのに、リクエスト境界で一切使われていない。まず検証に使うスキーマを core に用意する(適用は R-12/R-13)。
- **変更**: `packages/core/src/schemas.ts` の末尾に以下を追記する(既存スキーマは変更しない):

```ts
/** ===== API リクエストスキーマ (apps/api の入力検証用) ===== */

/** POST /api/chat */
export const ChatRequestSchema = z.object({
  message: z.string().min(1, "message は必須です"),
  mode: ChatModeSchema.default("integrated"),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string(),
      }),
    )
    .default([]),
  format: z.enum(FORMATS).optional(),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

/** POST /api/deck/parse */
export const DeckParseRequestSchema = z.object({
  decklist: z.string().min(1, "decklist は必須です"),
});
export type DeckParseRequest = z.infer<typeof DeckParseRequestSchema>;

/** POST /api/deck/evaluate */
export const DeckEvaluateRequestSchema = z.object({
  decklist: z.string().min(1, "decklist は必須です"),
  format: z.enum(FORMATS).default("original"),
});
export type DeckEvaluateRequest = z.infer<typeof DeckEvaluateRequestSchema>;

/** POST /api/deck/build */
export const DeckBuildRequestSchema = z.object({
  theme: z.string().min(1, "theme は必須です"),
  format: z.enum(FORMATS).default("original"),
  constraints: z
    .object({
      requiredCards: z.array(z.string()).optional(),
      excludeCards: z.array(z.string()).optional(),
      civilizations: z.array(z.string()).optional(),
      maxCost: z.number().optional(),
    })
    .default({}),
});
export type DeckBuildRequest = z.infer<typeof DeckBuildRequestSchema>;

/** POST /api/deck/suggest */
export const DeckSuggestRequestSchema = z.object({
  decklist: z.string().min(1, "decklist は必須です"),
  goals: z.array(z.string()).default([]),
});
export type DeckSuggestRequest = z.infer<typeof DeckSuggestRequestSchema>;
```

注意: `history` の要素で timestamp 等の未知キーは Zod が既定で除去する(現状 web が timestamp 付きで送っており、除去後の形は API が Gemini に渡している形と同一のため挙動互換)。

- **完了条件**: 共通完了条件。
- **リスク**: なし(追記のみ。この時点では未使用)。
- **依存**: 項目0

### R-11: api にグローバルエラーハンドラを追加(500 の統一とログ)

- **対象**: `apps/api/src/index.ts`
- **問題**: ルートハンドラに例外が伝播した場合(Gemini 障害・DB 例外・JSON パース失敗など)、Hono のデフォルト 500(text)が返り、サーバー側にスタックトレースが残らない。
- **変更**: `app.route(...)` 群の後に追記:

```ts
// 予期しない例外の共通ハンドリング (詳細はサーバーログのみに出し、クライアントには汎用文言を返す)
app.onError((err, c) => {
  console.error(`[api] ${c.req.method} ${c.req.path} で未処理エラー:`, err);
  return c.json({ error: "内部エラーが発生しました" }, 500);
});
```

- **完了条件**: 共通完了条件。加えて API を起動し(冒頭の共通手順どおり **GEMINI_API_KEY 無し**で):

```bash
curl -s -w '\n%{http_code}\n' -X POST http://localhost:3001/api/chat \
  -H 'Content-Type: application/json' -d '{"message":"hello"}'
# 期待: {"error":"内部エラーが発生しました"} と 500
# (GEMINI_API_KEY 未設定のため chat() が throw し、onError が捕捉する)
# サーバーログに "[api] POST /api/chat で未処理エラー: Error: GEMINI_API_KEY is not set" が出ること
```

- **リスク**: 低。成功パスの挙動は不変。
- **依存**: 項目0

### R-12: chat ルートの入力検証(ChatRequestSchema 適用)

- **対象**: `apps/api/src/routes/chat.ts:27-43`
- **問題**: `message` 未指定で undefined がそのまま Gemini/RAG に流れる。`mode` に任意文字列が来ると `SYSTEM_PROMPTS[mode]` が undefined になり、システムプロンプト無しで応答してしまう。
- **変更**: ハンドラ冒頭を差し替える:

```ts
// 変更前 (27-43行)
chatRouter.post("/", async (c) => {
  const body = await c.req.json<{ ... }>();
  const mode: ChatMode = body.mode ?? "integrated";
  const history = body.history ?? [];
  const messages = [...history, { role: "user" as const, content: body.message }];
  const systemPrompt = SYSTEM_PROMPTS[mode];
  const useTools = mode === "integrated";

// 変更後
chatRouter.post("/", async (c) => {
  const raw = await c.req.json().catch(() => null);
  const parsed = ChatRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json(
      {
        error: "リクエストが不正です",
        details: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      },
      400
    );
  }
  const { message, mode, history, format } = parsed.data;
  const messages = [...history, { role: "user" as const, content: message }];
  const systemPrompt = SYSTEM_PROMPTS[mode];
  const useTools = mode === "integrated";
```

これに伴い、ハンドラ内の `body.message` → `message`、`body.format` → `format` に置換する
(57-61行の `executeToolCall(toolCall.name, toolCall.args, body.format)` と 87行の
`searchRules(body.message)` の2箇所)。import に `ChatRequestSchema` を追加する
(`import { chat, ChatRequestSchema, type ChatMode } from "@dm-ai/core";`)。

- **完了条件**: 共通完了条件。加えて API 起動状態で:

```bash
curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:3001/api/chat \
  -H 'Content-Type: application/json' -d '{}'            # 期待: 400
curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:3001/api/chat \
  -H 'Content-Type: application/json' -d '{"message":""}' # 期待: 400
curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:3001/api/chat \
  -H 'Content-Type: application/json' -d 'not-json'       # 期待: 400
curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:3001/api/chat \
  -H 'Content-Type: application/json' -d '{"message":"hi"}' # 期待: 500 (R-11 の応答。GEMINI鍵なしのため)
```

- **リスク**: 低。**挙動変更(バグ修正)**: 不正リクエストが 500/誤動作ではなく 400 になる。
  `mode` に未知の値が来た場合も 400 になる(以前はプロンプト無しで通っていた)。
- **依存**: R-10, R-11

### R-13: deck ルートの入力検証(4エンドポイント)

- **対象**: `apps/api/src/routes/deck.ts` 全体
- **問題**: 全4エンドポイントが無検証。`decklist` 未指定だと `parseDecklist(undefined)` が `text.split` で TypeError になり 500。`format` に任意文字列が通る。
- **変更**: 各ハンドラの冒頭を R-12 と同じパターンで差し替える。共通ヘルパーをファイル内に置く:

```ts
import {
  DeckParseRequestSchema,
  DeckEvaluateRequestSchema,
  DeckBuildRequestSchema,
  DeckSuggestRequestSchema,
} from "@dm-ai/core";
import type { Context } from "hono";
import type { z } from "zod";

/** ボディを検証し、失敗時は 400 レスポンスを返す */
async function parseBody<S extends z.ZodTypeAny>(
  c: Context,
  schema: S,
): Promise<{ ok: true; data: z.infer<S> } | { ok: false; res: Response }> {
  const raw = await c.req.json().catch(() => null);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      res: c.json(
        {
          error: "リクエストが不正です",
          details: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
        },
        400,
      ),
    };
  }
  return { ok: true, data: parsed.data };
}
```

各ハンドラ(例: /evaluate):

```ts
// 変更前
deckRouter.post("/evaluate", async (c) => {
  const { decklist, format = "original" } = await c.req.json<{...}>();
// 変更後
deckRouter.post("/evaluate", async (c) => {
  const body = await parseBody(c, DeckEvaluateRequestSchema);
  if (!body.ok) return body.res;
  const { decklist, format } = body.data;
```

/parse は `DeckParseRequestSchema`、/build は `DeckBuildRequestSchema`(`theme`,`format`,`constraints` を取り出す)、/suggest は `DeckSuggestRequestSchema`(`decklist`,`goals`)で同様に置き換える。ハンドラ本体のロジック(parseDecklist / scoreDeck / validateRegulation / autoBuild / suggestReplacements の呼び出しと応答形状)は変更しない。

注意: `zod` は apps/api の直接依存に無いが、型 `z.ZodTypeAny` の参照は `@dm-ai/core` の型宣言経由では書けないため、apps/api の package.json の dependencies に `"zod": "^3.24.0"` を追加する(core と同じ指定。**新規バージョン導入ではなく、既にワークスペースに存在する依存の明示化**)。`pnpm install` で lockfile を更新しコミットに含める。

- **完了条件**: 共通完了条件。加えて API 起動状態で(DB 無しで確認可能):

```bash
curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:3001/api/deck/evaluate \
  -H 'Content-Type: application/json' -d '{}'   # 期待: 400
curl -s -X POST http://localhost:3001/api/deck/evaluate \
  -H 'Content-Type: application/json' -d '{"decklist":"4 テストカード"}' | head -c 200
# 期待: 200 で {"parsed":{...},"score":{...overall...},"validation":{...}} 形式の JSON
curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:3001/api/deck/build \
  -H 'Content-Type: application/json' -d '{}'   # 期待: 400
curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:3001/api/deck/parse \
  -H 'Content-Type: application/json' -d '{"decklist":"4 A"}'  # 期待: 200
```

- **リスク**: 低。**挙動変更(バグ修正)**: 不正入力が 500 ではなく 400 に。`format` の不正値も 400 に。
  また `decklist: ""`(空文字)はこれまで 200(空の解析結果)だったが 400 になる。
- **依存**: R-10, R-11

### R-14: meta ルートの format 検証と catch のログ追加

- **対象**: `apps/api/src/routes/meta.ts:7-14, 85-94, 100-136`
- **問題**: (1) `format` クエリに任意文字列が通る(SQL は安全だが、常に空結果になり原因が分かりにくい)。(2) 2つの catch がエラーを完全に握りつぶし、DB 障害と「データ0件」が区別できず、ログも出ない。
- **変更**:

```ts
// import に追加
import { FORMATS } from "@dm-ai/core";

// /tier ハンドラの既存行 `const format = c.req.query("format") ?? "original";` (8行目) は
// そのまま残し、その直後に以下の if ブロックだけを追加する
  if (!(FORMATS as readonly string[]).includes(format)) {
    return c.json(
      { error: `format は ${FORMATS.join(" | ")} のいずれかを指定してください` },
      400
    );
  }

// /archetype/:name ハンドラの format 取得行 (100行目) の直後にも同じ if ブロックを追加

// 85行目の catch: 変更前 `} catch {` → 変更後
  } catch (err) {
    console.error("[api/meta] tier 取得に失敗 (フォールバック応答を返します):", err);
// 129行目の catch も同様に
  } catch (err) {
    console.error("[api/meta] archetype 取得に失敗 (フォールバック応答を返します):", err);
```

**フォールバックのレスポンス形状(200 + 空データ)は変更しない**(web/bot がこの形に依存しているため。「DB 無しでも動く」設計は維持する)。

- **完了条件**: 共通完了条件。加えて API 起動状態で:

```bash
curl -s -o /dev/null -w '%{http_code}' 'http://localhost:3001/api/meta/tier?format=bogus'  # 期待: 400
curl -s 'http://localhost:3001/api/meta/tier' | head -c 120
# 期待: 200 で {"format":"original","period":"4w",... ,"tier_data":[]}
# サーバーログに "[api/meta] tier 取得に失敗" が出ること (DB 無しのため)
```

- **リスク**: 低。**挙動変更(バグ修正)**: format 不正値が 400 になる。
- **依存**: 項目0(R-11 とは独立)

### R-15: tools.ts の「宣言だけされて無視されるツールパラメータ」を削除

- **対象**: `apps/api/src/tools.ts:17-29, 67-82`、実装側 `apps/api/src/routes/chat.ts:138-154, 176-188`
- **問題**: Gemini に宣言している `search_cards` の `civilization` / `max_cost` / `type`、`get_tier_list` の `period` は、`executeToolCall` の実装で**一切参照されず無視される**。Gemini がこれらを指定しても結果に反映されず、モデルに嘘の API 仕様を教えている状態。フィルタの実装は機能追加になるため行わず、宣言側を実装に合わせて削る。
- **変更**: `tools.ts` の `search_cards.parameters.properties` から `civilization`・`max_cost`・`type` の3キーを削除(`query` のみ残す)。`get_tier_list.parameters.properties` から `period` を削除(`format` のみ残す)。`chat.ts` 側は変更しない。
- **完了条件**: 共通完了条件。`grep -n "civilization\|max_cost\|period" apps/api/src/tools.ts` が0件。
- **リスク**: 低。ツールの実挙動は元々 query/format しか使っていないため不変。
- **依存**: 項目0

### R-16: chat.ts の動的 import を静的 import に統一

- **対象**: `apps/api/src/routes/chat.ts:4, 167, 191`
- **問題**: 同一パッケージ `@dm-ai/deck-engine` を 4行目で静的 import しながら、`autoBuild`(167行)と `suggestReplacements`(191行)だけ `await import` で動的に取得しており、一貫性がなく読み手を惑わせる(遅延ロードする理由はない)。
- **変更**:

```ts
// 4行目: 変更前
import { parseDecklist, scoreDeck, validateRegulation } from "@dm-ai/deck-engine";
// 変更後
import {
  parseDecklist,
  scoreDeck,
  validateRegulation,
  autoBuild,
  suggestReplacements,
} from "@dm-ai/deck-engine";
```

167行の `const { autoBuild } = await import("@dm-ai/deck-engine");` と
191行の `const { suggestReplacements } = await import("@dm-ai/deck-engine");` を削除する。

- **完了条件**: 共通完了条件。`grep -n "await import" apps/api/src/routes/chat.ts` が0件。
- **リスク**: なし。
- **依存**: R-12(同一ファイルの変更が先に確定していること)

### R-17: chat.ts の96行ハンドラを責務単位の関数に分割

- **対象**: `apps/api/src/routes/chat.ts` ハンドラ本体(R-12/R-16 適用後のコード)
- **問題**: POST ハンドラが「検証 → Gemini 呼び出し → ツール実行ループ+再問い合わせ → rule モードの RAG 付加」の4責務を1関数に抱えて約100行あり、変更影響の見通しが悪い。
- **変更**: 同一ファイル内で2つの関数を抽出する。**応答 JSON の形状・文言は一切変えない**。

```ts
/** ツール呼び出しを実行し、結果を踏まえた再問い合わせの応答文を返す */
async function chatWithToolResults(
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  toolCalls: NonNullable<ChatResponse["toolCalls"]>,
  systemPrompt: string,
  responseText: string,
  format?: string,
): Promise<string> {
  const toolResults: string[] = [];
  for (const toolCall of toolCalls) {
    const result = await executeToolCall(toolCall.name, toolCall.args, format);
    toolResults.push(`[${toolCall.name}の結果]\n${result}`);
  }
  const followUp = await chat(
    [
      ...messages,
      { role: "assistant", content: responseText || "ツールを実行しています..." },
      {
        role: "user",
        content: `ツール実行結果:\n${toolResults.join("\n\n")}\n\nこの結果を踏まえてユーザーの質問に回答してください。`,
      },
    ],
    { systemPrompt, temperature: 0.3 },
  );
  return followUp.text;
}

/** rule モード: RAG 検索結果を付加して回答を生成する。ヒットが無ければ null */
async function chatWithRuleContext(
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  query: string,
  systemPrompt: string,
): Promise<{ text: string; citations: Array<Record<string, unknown>> } | null> {
  const searchResult = await searchRules(query);
  if (searchResult.chunks.length === 0) return null;
  const context = searchResult.chunks
    .map((ch, i) => `[${i + 1}] ${ch.meta.article ? `条${ch.meta.article}: ` : ""}${ch.text}`)
    .join("\n\n");
  const ragResponse = await chat(
    [
      ...messages,
      {
        role: "user",
        content: `以下のルール条文を参考に回答してください:\n\n${context}`,
      },
    ],
    { systemPrompt, temperature: 0.2 },
  );
  return {
    text: ragResponse.text,
    citations: searchResult.chunks.map((ch) => ({
      text: ch.text.slice(0, 100),
      ...ch.meta,
    })),
  };
}
```

ハンドラ本体は検証(R-12)+以下に縮小する:

```ts
const response = await chat(messages, {
  systemPrompt,
  tools: useTools ? TOOL_DEFINITIONS : undefined,
  temperature: 0.3,
});

if (response.toolCalls && response.toolCalls.length > 0) {
  const text = await chatWithToolResults(
    messages,
    response.toolCalls,
    systemPrompt,
    response.text,
    format,
  );
  return c.json({ response: text, toolCalls: response.toolCalls, mode });
}

if (mode === "rule") {
  const rag = await chatWithRuleContext(messages, message, systemPrompt);
  if (rag) {
    return c.json({ response: rag.text, citations: rag.citations, mode });
  }
}

return c.json({ response: response.text, mode });
```

`ChatResponse` 型は `import type { ChatResponse } from "@dm-ai/core";` を追加して参照する。

- **完了条件**: 共通完了条件。加えて R-12 の curl 4本を再実行し、同じ結果になること(回帰確認)。
- **リスク**: 中(Gemini 応答経路はローカルで完全には確認できない)。応答 JSON のキー名
  (`response` / `toolCalls` / `citations` / `mode`)が変わっていないことを diff で必ず確認する。
- **依存**: R-12, R-16

### R-18: meta.ts のティア集計ロジック抽出・閾値の定数化・web 表示文言の整合

- **対象**: `apps/api/src/routes/meta.ts:11-14, 20-95`、`packages/core/src/constants.ts`(追記)、`apps/web/src/app/meta/page.tsx:182`
- **問題**: (1) Tier 判定閾値(使用率 15% / 8%)が meta.ts のルートハンドラ内に直値で埋まっている。(2) web の画面は「Tier2 = 使用率 5% - 15%」と表示しており、**実装の 8% と食い違う**。(3) `periodStart.toISOString().split("T")[0]` が6回複製されている。(4) 89行のハンドラに集計ロジックが直書き。(5) **潜在バグ**: postgres.js は `COUNT(*)`(bigint)を**文字列**で返すため、51-54行の `results.reduce((sum, r) => sum + (r.count as number), 0)` は数値加算ではなく文字列連結になり(`0 + "3" + "2"` → `"032"`)、totalEntries が壊れて usage_rate の分母が不正になる。
- **変更**:

  (1) `packages/core/src/constants.ts` 末尾に追記:

```ts
/** ティア判定閾値 (大会結果からの集計時の使用率) */
export const TIER_THRESHOLDS = {
  tier1: 0.15,
  tier2: 0.08,
} as const;
```

(2) `meta.ts` の 31-39 行の集計 SQL の SELECT 句を以下に変更する(COUNT を int にキャスト。
上記(5)の修正。WHERE / GROUP BY / ORDER BY は変更しない):

```sql
        SELECT deck_archetype, COUNT(*)::int as count,
               (COUNT(*) FILTER (WHERE placement <= 8))::int as top8_count
```

(3) `meta.ts` にヘルパーを抽出し、直値を置換:

```ts
import { FORMATS, TIER_THRESHOLDS } from "@dm-ai/core";

/** Date → "YYYY-MM-DD" */
function isoDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

/** 大会結果の集計行をティアリストに変換する */
function aggregateTierData(results: Array<Record<string, unknown>>): Array<{
  tier: string;
  archetype: string;
  usage_rate: number;
  win_rate: null;
  sample_decklist: null;
}> {
  const totalEntries = results.reduce((sum, r) => sum + Number(r.count), 0);
  return results.map((r) => {
    const usageRate = Number(r.count) / totalEntries;
    const tier =
      usageRate >= TIER_THRESHOLDS.tier1
        ? "Tier1"
        : usageRate >= TIER_THRESHOLDS.tier2
          ? "Tier2"
          : "Tier3";
    return {
      tier,
      archetype: r.deck_archetype as string,
      usage_rate: Math.round(usageRate * 1000) / 10,
      win_rate: null,
      sample_decklist: null,
    };
  });
}
```

ハンドラ内の該当箇所(51-67行)を `const tierData = aggregateTierData(results);` に、
`periodStart.toISOString().split("T")[0]` / `periodEnd.toISOString().split("T")[0]` の
全出現(6箇所)を `isoDate(periodStart)` / `isoDate(periodEnd)` に置換する。
応答 JSON の形状・値は不変であること。

(4) `apps/web/src/app/meta/page.tsx:182` の表示文言を実装に合わせる:

```tsx
// 変更前
{
  tier === "Tier1" ? "15%以上" : "5% - 15%";
}
// 変更後 (API 実装 (TIER_THRESHOLDS.tier2 = 8%) と整合させる。web は core 非依存のため直値+根拠コメント)
{
  /* 閾値は apps/api の TIER_THRESHOLDS (15% / 8%) と一致させること */
}
{
  tier === "Tier1" ? "15%以上" : "8% - 15%";
}
```

- **完了条件**: 共通完了条件。加えて API 起動状態で `curl -s 'http://localhost:3001/api/meta/tier'` が R-14 と同じ 200 応答(DB 無し時は tier_data: [])。`pnpm --filter @dm-ai/web build` 成功。
- **リスク**: 低〜中。集計は純粋な変換のため diff で同値性を確認できるが、COUNT の文字列問題(5)の修正は DB 実環境でのみ効果が観測できる(**挙動変更=バグ修正**: スナップショット不在時の usage_rate が正しい分母で計算されるようになる)。**表示文言の変更は「実装と食い違う表記の修正」であり仕様変更ではない**。
- **依存**: R-14

### R-19: builder.ts の直値 40 / 4 を core 定数に置換

- **対象**: `packages/deck-engine/src/builder.ts:38-40, 70, 78, 90-91, 99, 110-113, 132`
- **問題**: デッキ上限 40 と同名上限 4 が計10箇所前後に直値で散在。同パッケージの validator.ts は `DECK_SIZE` / `MAX_COPIES` を参照しており、パッケージ内で不統一。
- **変更**: import を追加し、**「デッキ40枚」「同名4枚」を意味する直値のみ**を置換する:

```ts
import { DECK_SIZE, MAX_COPIES, type Format, type DeckEntry } from "@dm-ai/core";
```

置換対象(値の変更はしない): 38-40行 `count: 4` → `count: MAX_COPIES` / `totalCards += 4` → `+= MAX_COPIES`、70行 `totalCards >= 40` → `>= DECK_SIZE`、78行 `let count = 4` → `= MAX_COPIES`、88行の `if (cost >= 7) count = Math.min(count, 2);` は**そのまま**(7コスト・2枚はデッキ上限とは別概念のため変更しない)、90-91行 `totalCards + count > 40` → `> DECK_SIZE` / `40 - totalCards` → `DECK_SIZE - totalCards`、99行 `totalCards < 40` → `< DECK_SIZE`、110行 `totalCards >= 40` → `>= DECK_SIZE`、113行 `Math.min(4, 40 - totalCards)` → `Math.min(MAX_COPIES, DECK_SIZE - totalCards)`、132行 `total < 40` → `< DECK_SIZE`(メッセージ内の「40枚必要」は `${DECK_SIZE}枚必要` に変更してよい)。
autoBuild の関数分割は行わない(テストで守れないため。§4 参照)。

- **完了条件**: 共通完了条件。`grep -n " 40\|(40\|>40\|<40" packages/deck-engine/src/builder.ts` で「デッキ枚数の意味の40」が残っていないことを目視確認。
- **リスク**: 低(数値は同一。機械的置換)。
- **依存**: 項目0

### R-20: scorer.ts scoreDeck(114行)の指標計算を純関数に分割

- **対象**: `packages/deck-engine/src/scorer.ts`(R-08/R-09 適用後のコード)
- **問題**: scoreDeck がカード情報取得・6種の指標計算・警告文生成を1関数に抱えて約110行ある。
- **変更**: 同一ファイル内で以下の純関数を抽出する。**特性テスト(完全一致比較)が通ること=出力不変が完了条件**なので、警告文の文言・配列順序を一切変えないこと。

```ts
/** DB行 → Card 変換 (fetchCardInfo から抽出) */
function rowToCard(row: Record<string, unknown>): Card {
  /* R-08 の map.set の中身 */
}

/** デッキエントリをカード情報で展開 (カード×枚数) */
function expandCards(entries: DeckEntry[], cardInfo: Map<string, Card>): Card[];

/** コストカーブ集計 */
function computeCostCurve(cards: Card[]): { low: number; mid: number; high: number };

/** 文明比率集計 */
function computeCivilizationBalance(cards: Card[]): Record<string, number>;

/** 役割タグ集計 */
function computeRoleBalance(cards: Card[]): Record<string, number>;
```

`import type { DeckEntry } from "@dm-ai/core";` を追加。scoreDeck は「取得 → 各 compute 呼び出し →
警告/提案の組み立て → calculateOverallScore」のオーケストレーションに縮小する。警告・提案の
push 順序は現状のコード順(トリガー → 多色 → 低コスト → 色事故 → 受け → ドロー)を厳守する。

- **完了条件**: 共通完了条件。**scorer.test.ts が期待値の変更なしで PASS**(これが出力不変の証明)。
- **リスク**: 低(特性テストが完全一致で守っている)。
- **依存**: R-08, R-09

### R-21: worker の重複ユーティリティと公式サイト URL の集約

- **対象**: `apps/worker/src/jobs/ingest-cards.ts:8, 180-196`、`apps/worker/src/jobs/ingest-rules.ts:10-11, 88-90`、`apps/worker/src/jobs/ingest-regulations.ts:7-8`
- **問題**: `sleep` が2ファイルに全く同一の実装で複製され、公式サイトのドメイン文字列が3ファイルに散在している。
- **変更**: 新規ファイル2つを作り、3ジョブから参照する。

  `apps/worker/src/constants.ts`:

```ts
/** 公式サイトのベースURL (全取り込みジョブ共通) */
export const OFFICIAL_SITE_BASE_URL = "https://dm.takaratomy.co.jp";
```

`apps/worker/src/lib.ts`(ingest-cards.ts から**移動**。実装は変えない):

```ts
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchWithRetry(url: string, retries = 3): Promise<string> {
  /* ingest-cards.ts 180-192行の実装をそのまま移動 */
}
```

各ジョブの変更: ingest-cards は `BASE_URL` 定義を `const BASE_URL = OFFICIAL_SITE_BASE_URL;` に
変更し、ローカルの sleep / fetchWithRetry 定義を削除して import に置換。ingest-rules は
`RULES_PDF_URL` を `` `${OFFICIAL_SITE_BASE_URL}/rule/pdf/dm_comprehensive_rules.pdf` `` に変更し、
ローカル sleep を削除して import。ingest-regulations は `REGULATION_URL` を
`` `${OFFICIAL_SITE_BASE_URL}/rule/regulation/` `` に変更する。
**fetchWithRetry を rules / regulations の生 fetch に適用することはしない**(リトライ付与は挙動変更のため)。

- **完了条件**: 共通完了条件。`grep -rn "takaratomy" apps/worker/src/jobs/` が0件(constants.ts のみに存在)。`grep -c "function sleep" apps/worker/src/jobs/*.ts` が全ファイル0。
- **リスク**: 低(定義の移動と文字列合成のみ。URL の最終値が変更前と同一であることを目視確認)。
- **依存**: R-04, R-07(同一ファイル群の変更が先に確定していること)

### R-22: ingest-cards の文明判定 if 羅列を CIVILIZATIONS 定数ループに置換

- **対象**: `apps/worker/src/jobs/ingest-cards.ts:103-112`(R-04 適用後のコード)
- **問題**: core の `CIVILIZATIONS` 定数と同じ5文明を if 文の羅列で再実装している(6文明目が増えたとき追随漏れする)。worker は @dm-ai/core に依存済み。
- **変更**:

```ts
// import を追加
import { CIVILIZATIONS } from "@dm-ai/core";

// 変更前 (105-112行)
civElements.each((_, el) => {
  const civClass = $(el).attr("class") ?? "";
  if (civClass.includes("fire")) civilizations.push("fire");
  if (civClass.includes("water")) civilizations.push("water");
  if (civClass.includes("nature")) civilizations.push("nature");
  if (civClass.includes("light")) civilizations.push("light");
  if (civClass.includes("darkness")) civilizations.push("darkness");
});

// 変更後 (判定順は CIVILIZATIONS の定義順 = 変更前と同一)
civElements.each((_, el) => {
  const civClass = $(el).attr("class") ?? "";
  for (const civ of CIVILIZATIONS) {
    if (civClass.includes(civ)) civilizations.push(civ);
  }
});
```

- **完了条件**: 共通完了条件。
- **リスク**: 低。`CIVILIZATIONS` の配列順(fire, water, nature, light, darkness)が if 文の順と同一であることを constants.ts で確認済み(push 順序が保たれる)。
- **依存**: R-04, R-21

### R-23: bot の login 未処理 Promise と any 型 API クライアントの修正

- **対象**: `apps/bot/src/index.ts:28`、`apps/bot/src/commands/index.ts:236-253` と各呼び出し箇所
- **問題**: (1) `client.login(token)` の Promise が未処理で、トークン不正時に unhandledRejection でスタックだけ出て落ちる。(2) `apiPost`/`apiGet` が `Promise<any>` を返し(eslint-disable 付き)、レスポンスの全プロパティアクセスが無検査。
- **変更**:

```ts
// apps/bot/src/index.ts:28 — 変更前
client.login(token);
// 変更後
client.login(token).catch((err) => {
  console.error("Discord へのログインに失敗しました:", err);
  process.exit(1);
});
```

```ts
// apps/bot/src/commands/index.ts — 変更前 (236-253行)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function apiPost(path: string, body: unknown): Promise<any> { ... }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function apiGet(path: string): Promise<any> { ... }

// 変更後 (ジェネリクス化。eslint-disable 行は削除)
async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json() as Promise<T>;
}

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`);
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json() as Promise<T>;
}
```

呼び出し側に型引数を与える。ファイル冒頭に追記:

```ts
import type { DeckScore, ValidationResult } from "@dm-ai/core";

interface TierEntry {
  tier: string;
  archetype: string;
  usage_rate: number;
}
```

各呼び出し: `handleRule`/`handleChat` → `apiPost<{ response: string }>`、
`handleDeck` rate/check → `apiPost<{ score: DeckScore; validation: ValidationResult }>`、
build → `apiPost<{ entries: Array<{ name: string; count: number }> }>`(`.map` の引数
`(e: {...})` の注釈は不要になるため削除可)、
tier → `apiGet<{ tier_data: TierEntry[] }>`(`.filter` の `(e: {...})` 注釈も削除可)、
archetype → `apiGet<{ archetype: string; stats: { total_entries: number; wins: number; top8: number } | null }>`

- **完了条件**: 共通完了条件(bot の typecheck が通ること)。Discord への接続確認は不要(トークン無しでは不可能なため)。
- **リスク**: 低〜中。型引数の付け間違いは typecheck で検出される。実行時挙動は login の
  エラーハンドリング以外不変。
- **依存**: 項目0

### R-24: bot の Discord Embed 色の直値を定数化

- **対象**: `apps/bot/src/commands/index.ts:65, 102, 124, 139, 173, 203`
- **問題**: 5色の16進カラーコードが6箇所に直値で散在し、同じ「緑=成功」「赤=エラー」の意図が読み取れない。
- **変更**: ファイル冒頭(API_URL の近く)に追加し、各出現を置換:

```ts
/** Embed の配色 (Tailwind 由来のブランドカラー) */
const EMBED_COLORS = {
  info: 0x3182ce, // ルール回答
  success: 0x38a169, // 高スコア / チェックOK
  warning: 0xecc94b, // 中スコア
  danger: 0xe53e3e, // 低スコア / チェックNG
  accent: 0x6366f1, // 構築・メタ表示
} as const;
```

置換: 65行 `0x3182ce` → `EMBED_COLORS.info`、102行 `score.overall >= 70 ? 0x38a169 : score.overall >= 40 ? 0xecc94b : 0xe53e3e` → `score.overall >= 70 ? EMBED_COLORS.success : score.overall >= 40 ? EMBED_COLORS.warning : EMBED_COLORS.danger`、124行 `0x6366f1` → `EMBED_COLORS.accent`、139行 `v.valid ? 0x38a169 : 0xe53e3e` → `v.valid ? EMBED_COLORS.success : EMBED_COLORS.danger`、173行・203行 `0x6366f1` → `EMBED_COLORS.accent`。

- **完了条件**: 共通完了条件。`grep -n "0x[0-9a-f]\{6\}" apps/bot/src/commands/index.ts` の出現が EMBED_COLORS 定義内の5件のみ。
- **リスク**: なし(値は同一)。
- **依存**: R-23(同一ファイルの変更が先に確定していること)

### R-25: web の重複型定義・重複ユーティリティをローカル lib に集約

- **対象**: `apps/web/src/app/page.tsx:6-17`、`apps/web/src/app/rule/page.tsx:6-25`、`apps/web/src/app/deck/page.tsx:6-22, 60-67`、`apps/web/src/app/meta/page.tsx:6-19`
- **問題**: `Message` / `Citation` / `DeckScore` / `ValidationResult` / `TierEntry` / `TierData` の型と `getTime()` / `scoreGrade()` が複数ページに重複定義されている(Message は2ページ、getTime は2ページで完全同一)。web はワークスペース非依存の方針のため、web 内のローカル lib に集約する。
- **変更**: 新規ファイル2つを作成し、4ページの重複定義を削除して import に置換する。

  `apps/web/src/lib/types.ts`(各ページの現定義をそのまま移動。フィールドの追加・変更はしない):

```ts
/** API レスポンスの型 (apps/api の応答形状の写し。API 側を変えたらここも追随する) */

export interface Citation {
  text: string;
  section?: string;
  article?: string;
  url?: string;
}

export interface Message {
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
  timestamp?: string;
}

export interface DeckScore {
  triggerCount: number;
  rainbowCount: number;
  costCurve: { low: number; mid: number; high: number };
  civilizationBalance: Record<string, number>;
  openingHandRate: number;
  roleBalance: Record<string, number>;
  overall: number;
  warnings: string[];
  suggestions: string[];
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface TierEntry {
  tier: string;
  archetype: string;
  usage_rate: number;
  win_rate: number | null;
}

export interface TierData {
  format: string;
  period: string;
  period_start: string;
  period_end: string;
  tier_data: TierEntry[];
}
```

`apps/web/src/lib/format.ts`:

```ts
/** 現在時刻の "HH:MM" 表記 (チャットのタイムスタンプ用) */
export function getTime(): string {
  return new Date().toLocaleTimeString("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 総合スコア → グレード表記 */
export function scoreGrade(overall: number): string {
  if (overall >= 90) return "S+";
  if (overall >= 80) return "S";
  if (overall >= 70) return "A";
  if (overall >= 60) return "B";
  if (overall >= 50) return "C";
  return "D";
}
```

各ページの変更: page.tsx は `Message`(citations 無し版)と `getTime` のローカル定義を削除し
`import { getTime } from "@/lib/format"; import type { Message } from "@/lib/types";` を追加
(page.tsx の Message は citations を使わないが、optional のため共通型で代替可能)。
rule/page.tsx は `Citation`/`Message`/`getTime` を削除して import。deck/page.tsx は
`DeckScore`/`ValidationResult`/`scoreGrade` を削除して import。meta/page.tsx は
`TierEntry`/`TierData` を削除して import。JSX・ロジックは一切変更しない。

- **完了条件**: 共通完了条件。加えて `grep -rn "interface Message\|interface DeckScore\|interface TierEntry\|function getTime\|function scoreGrade" apps/web/src/app/` が0件。`pnpm --filter @dm-ai/web build` 成功。
- **リスク**: 低。型の移動と import 置換のみで実行時挙動は不変。
- **依存**: R-18(meta/page.tsx の変更が先に確定していること)

### R-26: web の文明カラー定義の重複を統一

- **対象**: `apps/web/src/app/deck/page.tsx:24-58, 409-440`(R-25 適用後のコード)
- **問題**: 同一ファイル内に「Tailwind クラス版の色定義(CIV_COLORS, 24-50行)」と「ドーナツグラフ用の16進カラー(colorMap, 416-422行)」が別々に存在し、同じ5文明の色が二重管理されている。CIV_LABELS も同ファイルに直書き。
- **変更**: `apps/web/src/lib/civ.ts` を新規作成し、deck/page.tsx の `CIV_COLORS`(24-50行)と `CIV_LABELS`(52-58行)を**そのまま移動**、さらに JSX 内の `colorMap`(416-422行)をファイル外の定数として同居させる:

```ts
/** 文明ごとの表示色 (Tailwind クラス) */
export const CIV_COLORS: Record<string, { bg: string; text: string; dot: string }> = {
  /* deck/page.tsx 24-50行をそのまま移動 */
};

/** 文明の英語表示ラベル */
export const CIV_LABELS: Record<string, string> = {/* deck/page.tsx 52-58行をそのまま移動 */};

/** 文明ごとの16進カラー (SVG 描画用。CIV_COLORS の dot と同色) */
export const CIV_HEX: Record<string, string> = {
  fire: "#ef4444",
  water: "#3b82f6",
  nature: "#22c55e",
  light: "#facc15",
  darkness: "#6b7280",
};
```

deck/page.tsx はローカル定義を削除して `import { CIV_COLORS, CIV_LABELS, CIV_HEX } from "@/lib/civ";` を追加し、JSX 内 reduce の `const colorMap ... = {...}` を削除して `stroke={colorMap[civ] ?? "#6b7280"}` を `stroke={CIV_HEX[civ] ?? "#6b7280"}` に置換する。

- **完了条件**: 共通完了条件。`pnpm --filter @dm-ai/web build` 成功。`grep -n "colorMap" apps/web/src/app/deck/page.tsx` が0件。
- **リスク**: 低。値は同一のまま移動のみ。
- **依存**: R-25

### R-27: 最終確認(作業項目ではなくゲート)

全項目完了後に以下を実行し、すべて成功したら作業完了とする:

```bash
pnpm install          # lockfile が clean であること (差分が出ないこと)
pnpm build && pnpm typecheck && pnpm test   # すべて成功
git status            # working tree clean
git log --oneline refactor/plan-2026-07 ^main | wc -l   # 期待: 28 (項目0の2コミット + R-01〜R-26)
```

API 起動 + 以下のスモーク(全て DB/Gemini 無しで確認可能):

```bash
curl -s http://localhost:3001/health                                    # {"status":"ok"}
curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:3001/api/chat -H 'Content-Type: application/json' -d '{}'   # 400
curl -s -X POST http://localhost:3001/api/deck/evaluate -H 'Content-Type: application/json' -d '{"decklist":"4 テストカード"}' | grep -o '"overall":[0-9]*'  # "overall":30
curl -s 'http://localhost:3001/api/meta/tier' | grep -o '"tier_data":\[\]'  # "tier_data":[]
```

---

## 4. やらないことリスト

「善意でやりたくなるが、この作業では禁止」の一覧。ここに載っていることを見つけても**着手せず、
完了報告に「気づき」として書くだけ**にすること。

### 4.1 機能追加の禁止

- `autoBuild` の未実装部分(`format` 引数によるフィルタ、`constraints.excludeCards` / `civilizations` / `maxCost`)を実装しない。未使用引数を削除もしない(API の受け口として既に公開されており、削除は契約変更になる)。
- `suggestReplacements` が `original: ""` を返す仕様を「改善」しない。
- `search_cards` / `get_tier_list` ツールのフィルタパラメータを実装しない(R-15 で宣言側を削るだけ)。
- `POST /api/meta/ingest/url`(未実装スタブ)を実装しない・削除もしない(README に記載のある公開エンドポイントのため)。
- `autoBuild` の `requiredCards` に殿堂チェックを追加しない。
- レート制限・認証・ストリーミング応答・リトライ・キャッシュ等の新機能を追加しない。
- ingest 系スクレイパーの CSS セレクタや取得ロジックを「動きそうな形」に変更しない(実サイトで検証できないため。R-04/R-07 で明記した変更のみ)。

### 4.2 仕様・契約の変更禁止

- API レスポンス JSON のキー名・構造を変更しない(snake_case → camelCase 統一を含む。web/bot が依存)。
- core の Zod スキーマの**既存フィールド名**を変更しない(R-10 は追記のみ)。
- エンドポイントのパス・メソッドを変更しない。
- Discord のコマンド定義(`deploy-commands.ts`)を変更しない(変更すると再デプロイが必要になる)。
- システムプロンプトの文言、Gemini のモデル名・temperature の値を変更しない(temperature の定数化すらしない — 値の意図が不明なため現状維持)。
- UI の見た目・文言を変更しない(唯一の例外は R-18 の「5% - 15%」→「8% - 15%」)。
- エラー時に 200+空データを返す「DB 無しでも動く」フォールバック設計を変更しない(ログ追加のみ)。

### 4.3 依存関係・環境の変更禁止

- 依存ライブラリのバージョンを更新しない(next / react / typescript / discord.js / drizzle 等すべて)。
- 新規ライブラリを追加しない。例外は2つだけ: 項目0の `vitest`、R-13 の apps/api への `zod`(ワークスペース既存依存の明示化)。
- **`drizzle-orm` / `drizzle-kit` / `@supabase/supabase-js` と `getDb` / `getSupabase` / `packages/db/src/schema.ts` を削除しない**。リポジトリ内で未使用(デッドコード)であることは確認済みだが、Supabase 認証や Drizzle マイグレーションへの移行を見越した将来資産の可能性があり、削除はオーナー判断が必要。knip 等の未使用検出ツールに従って消したくなっても消さないこと。
- Node / pnpm のバージョン、tsconfig、turbo.json、.gitignore を変更しない。
- `pnpm-lock.yaml` を手で編集しない(`pnpm install` の結果のみコミット)。

### 4.4 スコープ外の変更禁止

- web のページコンポーネント分割・デザインリファクタをしない(視覚回帰を検証する手段がないため。deck/page.tsx が442行あるのは既知だが、今回は R-25/R-26 の型・定数抽出まで)。
- web に `@dm-ai/core` への依存を追加しない(Next.js の transpilePackages 設定が必要になり、ビルド構成の変更はスコープ外)。
- CI・lint 設定・フォーマッタ(prettier 等)を導入しない。一括再フォーマットをしない。
- カバレッジ 80% を目指したテストの網羅的追加をしない(特性テストは安全網であり、テスト拡充は別作業)。
- README.md / START.md の書き換えをしない(コードと矛盾する記述に気づいても報告に留める)。
- `packages/deck-engine/src/index.ts` の named export と他パッケージの `export *` の形式統一をしない(効果が薄い純スタイル変更のため)。

### 4.5 既知の課題(今回のスコープ外。報告書に転記するだけでよい)

実行者が発見しても対応不要。オーナーへの申し送り事項:

1. `ingest-cards.ts` はカード種別(`.cardType` のテキスト、例「クリーチャー」)を**日本語のまま** `cards.type` に格納する。core の `CardType` enum("creature" 等)と不整合であり、`CardSchema.parse` を実データに適用すると失敗する。日本語→enum のマッピング表が必要だが、実サイトの表記が検証できないため今回は見送り。
2. `effective_from` は常に固定日付(R-07 で定数化はするが、実際の施行日は取得していない)。
3. web の `layout.tsx` が `<head>` に Google Fonts の `<link>` を直書きしている(Next.js は `next/font` を推奨)。
4. README の技術スタック表に「Next.js 15」とあるが、実際にインストールされているのは 16.1.6。
5. bot のユーザー別フォーマット設定はプロセス内メモリのため再起動で消える。
6. `chunkBySize` のオーバーラップは文境界ではなく文字数ベースで、文の途中から次チャンクが始まる。
7. API に CORS 以外のセキュリティ機構(レート制限・入力サイズ上限)がない。

---

## 5. 実行者への指示文

以下をそのままコピーして実行 AI に渡すこと。

```
あなたは ~/DM-AI リポジトリのリファクタリング実行者です。
リポジトリ直下の REFACTORING_PLAN.md が唯一の作業指示書です。以下のルールを厳守してください。

1. まず REFACTORING_PLAN.md を最後まで読み、§1(現状理解)と §4(やらないことリスト)を
   把握してから作業を開始すること。
2. §2(項目0: 安全網)を最初に完了させること。ベースライン確認(§2.2)が1つでも失敗したら、
   作業を開始せずログを添えて報告すること。
3. 作業項目(R-01〜R-26)を §3 に書かれた順序どおり、1項目ずつ実施すること。
   並行作業・順序の入れ替え・複数項目の一括実施は禁止。
4. 1項目 = 1コミット。コミットメッセージは「<type>: <要約> (R-XX)」形式
   (type は refactor / fix / test / chore / docs のいずれか。例: "fix: cards.official_id を
   UNIQUE 化し ON CONFLICT を機能させる (R-04)")。
5. 各項目の完了条件(共通: pnpm build && pnpm typecheck && pnpm test の成功、および項目ごとの
   追加条件)をすべて満たしてからコミットすること。満たせない場合は変更を破棄
   (git checkout . など)して作業を中断し、どの項目のどの完了条件がどう失敗したかを報告すること。
   完了条件を満たすためにテストの期待値を書き換えることは禁止
   (計画書が明示的に指示している箇所を除く)。
6. 計画書に書かれていない変更をしないこと。§4(やらないことリスト)に該当する変更は、
   たとえ改善に見えても行わないこと。計画と実際のコードが食い違っていて判断できない場合は、
   推測で進めず中断して報告すること。
7. 行番号はベースコミット時点のものであり、先行項目の変更でずれることがある。
   引用されているコード片で位置を特定すること。引用コードが見つからない場合は中断して報告。
8. すべての項目が完了したら R-27(最終確認)を実行し、以下を含む完了報告を書くこと:
   - 各項目の結果一覧(コミットハッシュ付き)
   - スキップ・失敗した項目とその理由
   - 作業中に気づいたが §4 に従って手を付けなかった事項
9. main ブランチへのマージ・プッシュは行わず、refactor/plan-2026-07 ブランチに残して終了すること。
```
