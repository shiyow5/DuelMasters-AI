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

test("タブレット幅(900px)でもサイドバーはオフキャンバス (#53 breakpoint=lg)", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await page.goto("/");
  const nav = page.locator("nav");
  // lg(1024px) 未満なので常設ではなくオフキャンバス
  await expect.poll(async () => (await nav.boundingBox())?.x ?? 0).toBeLessThan(0);
  await expect(page.getByRole("button", { name: "メニューを開く" })).toBeVisible();
});

test("チャット送信で SSE が流れ、Gemini 未設定なら赤字でエラーを伝える", async ({ page }) => {
  // E2E は GEMINI_API_KEY を渡さない (playwright.config.ts の方針)。
  // api は SSE を開始したあとエージェントで落ちるので、error イベントが返る。
  // ストリーミングの配管 (エンドポイント → SSE フレーム → パーサ → UI) を一気に通すテスト。
  await page.goto("/");
  await page.locator("textarea").first().fill("S・トリガーは必ず使いますか?");
  await page.locator('button[type="submit"]').click();

  // 送信直後に応答用のバブルが出る (最初のトークンを待たずに置く)
  await expect(page.getByText("S・トリガーは必ず使いますか?")).toBeVisible();

  const error = page.getByText("回答の生成に失敗しました");
  await expect(error).toBeVisible({ timeout: 30000 });
  // エラーは赤字で出す (握り潰さない)
  await expect(error).toHaveClass(/text-danger/);
});
