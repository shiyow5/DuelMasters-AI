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
  webServer: [
    {
      command: "pnpm --filter @dm-ai/api dev",
      port: 3001,
      reuseExistingServer: true,
      timeout: 60000,
      env: { ALLOW_ANONYMOUS: "true" },
    },
    {
      command: "pnpm dev",
      port: 3000,
      reuseExistingServer: true,
      timeout: 60000,
      env: { NEXT_PUBLIC_ALLOW_ANONYMOUS: "true" },
    },
  ],
});
