import { defineConfig } from "@playwright/test";

/**
 * E2E スモーク。API(3001) と Web(3000) を webServer で起動する。
 * env は付けない = DB/Gemini 無しの劣化動作でスモークする。
 * ルートの `pnpm test`(vitest)には含めず、`pnpm --filter @dm-ai/web e2e` で実行する。
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["html", { open: "never" }], ["github"]] : "list",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  // E2E は Supabase を構成しないため、ログイン必須のままでは何も操作できない。
  // ALLOW_ANONYMOUS で明示的に opt-out する。既定 (本番) は認証必須。
  // 本番 Worker への混入は deploy.yml が検査して落とす。
  //
  // このスイートは「DB も Gemini も無い劣化動作」を前提にしている
  // (デッキ評価の固定スコア 30/100、チャットのエラー表示)。そのため:
  //
  // - `webServer.env` は **process.env にマージされる** (置き換えではない)。開発者のシェルに
  //   GEMINI_API_KEY や DATABASE_URL があると本物の応答が返ってテストが落ちるので、
  //   明示的に空へ潰す。
  // - `reuseExistingServer` は **切る**。既に上がっているサーバーを使い回すと、上の env 上書きが
  //   一切効かないまま開発者のサーバーに繋がってしまう (原因の分かりにくい失敗になる)。
  //   ポートが埋まっていれば Playwright は起動に失敗する。それでよい —
  //   「本物の Gemini 相手に静かに誤ったテストをする」より、はっきり落ちるほうがましなので。
  webServer: [
    {
      command: "pnpm --filter @dm-ai/api dev",
      port: 3001,
      reuseExistingServer: false,
      timeout: 60000,
      env: { ALLOW_ANONYMOUS: "true", GEMINI_API_KEY: "", DATABASE_URL: "" },
    },
    {
      command: "pnpm dev",
      port: 3000,
      reuseExistingServer: false,
      timeout: 60000,
      env: { NEXT_PUBLIC_ALLOW_ANONYMOUS: "true" },
    },
  ],
});
