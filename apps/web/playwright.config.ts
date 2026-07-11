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
  use: {
    baseURL: "http://localhost:3000",
  },
  webServer: [
    {
      command: "pnpm --filter @dm-ai/api dev",
      port: 3001,
      reuseExistingServer: true,
      timeout: 60000,
    },
    {
      command: "pnpm dev",
      port: 3000,
      reuseExistingServer: true,
      timeout: 60000,
    },
  ],
});
