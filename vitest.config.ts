import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/tests/**/*.test.ts", "apps/**/tests/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
    // 統合テストは単一の共有 DB に対して各ファイルの beforeEach で truncateAll() する。
    // ファイル並列実行だと別ファイルの TRUNCATE が実行中テストの行を消して競合するため、
    // ファイル単位の並列を無効化して直列実行する (小規模スイートなので許容範囲)。
    fileParallelism: false,
    // DB 未接続時の劣化動作を固定するため、DATABASE_URL を強制的に空にする。
    // 統合テストは各ファイルの beforeAll で enableAppDb() により個別に上書きする。
    env: { DATABASE_URL: "" },
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**", "apps/api/src/**", "apps/worker/src/**"],
      reporter: ["text", "html"],
    },
  },
});
