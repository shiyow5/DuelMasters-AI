import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/**/tests/**/*.test.ts",
      "apps/**/tests/**/*.test.ts",
      "tests/**/*.test.ts",
    ],
    environment: "node",
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
