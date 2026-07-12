import { test, expect } from "@playwright/test";

test("トップ(チャット)が表示され、空入力では送信ボタンが disabled", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("DM AI Master へようこそ")).toBeVisible();
  const sendBtn = page.locator('button[type="submit"]');
  await expect(sendBtn).toBeDisabled();
});

test("/deck でデッキを評価すると 30/100 が表示される (DB無し固定スコア)", async ({ page }) => {
  await page.goto("/deck");
  const list = Array.from({ length: 10 }, (_, i) => `4 テスト${i}`).join("\n");
  await page.locator("textarea").first().fill(list);
  await page.getByRole("button", { name: "評価する" }).click();
  await expect(page.getByText("30/100")).toBeVisible({ timeout: 15000 });
});

test("Delete Chat が confirm 経由で履歴を空にする (0件でも UI が壊れない)", async ({ page }) => {
  await page.goto("/");
  page.on("dialog", (d) => d.accept());
  await page.locator('button[title="Delete Chat"]').click();
  await expect(page.getByText("DM AI Master へようこそ")).toBeVisible();
});

test("モバイル幅ではサイドバーをハンバーガーで開閉できる (#53 off-canvas)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const nav = page.locator("nav");
  // 初期はオフキャンバス (画面左外に退避 = x が負)
  await expect.poll(async () => (await nav.boundingBox())?.x ?? 0).toBeLessThan(0);
  // ハンバーガーで開くと x=0 まで出てくる
  await page.getByRole("button", { name: "メニューを開く" }).click();
  await expect.poll(async () => Math.round((await nav.boundingBox())?.x ?? -1)).toBe(0);
  await expect(page.getByRole("link", { name: "ルール検索" })).toBeVisible();
  // クローズボタンで再びオフキャンバスへ
  await page.getByRole("button", { name: "メニューを閉じる" }).click();
  await expect.poll(async () => (await nav.boundingBox())?.x ?? 0).toBeLessThan(0);
});
