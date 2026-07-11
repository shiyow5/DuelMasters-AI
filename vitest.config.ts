import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/tests/**/*.test.ts"],
    environment: "node",
    // DB 未接続時の劣化動作を固定するため、DATABASE_URL を強制的に空にする
    env: { DATABASE_URL: "" },
  },
});
