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
