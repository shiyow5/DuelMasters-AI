import { test, expect, type Page } from "@playwright/test";

/**
 * UI改善 P-2 (狭幅ヘッダ 2 段化) / P-3 (評価完了時に結果へ移動) の回帰。
 * smoke.spec.ts と同じく DB/Gemini 無しの劣化動作 (固定スコア 55/100 = ランク C) を前提にする。
 */

const DECKLIST = Array.from({ length: 10 }, (_, i) => `4 テスト${i}`).join("\n");

async function evaluate(page: Page) {
  await page.goto("/deck");
  await page.locator("textarea").first().fill(DECKLIST);
  await page.getByRole("button", { name: "評価する" }).click();
}

test.describe("P-2 ヘッダ: 640px 未満は 2 段で見出しを 1 行に保つ", () => {
  const pages = [
    { path: "/deck", title: "デッキ構築・評価" },
    { path: "/meta", title: "環境分析" },
    { path: "/", title: "AI戦略アドバイザー" },
    { path: "/rule", title: "AIルール審査員" },
  ];

  for (const width of [320, 375, 414]) {
    for (const { path, title } of pages) {
      test(`${width}px ${path}: 見出しが折れず、ヘッダが膨らまない`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        await page.goto(path);
        const heading = page.locator("header").getByText(title, { exact: true });
        await expect(heading).toBeVisible();
        // 1 行なら高さは line-height 1 つ分 (text-lg/xl で 28px 前後)。折れると倍になる
        const h = (await heading.boundingBox())!.height;
        expect(h).toBeLessThan(40);
        const header = (await page.locator("header").boundingBox())!;
        // 修正前は見出しが縦に折れて約 310px あった。2 段の実測は 105〜121px
        // (アイコンボタンが行ボックス込みで 46px になる chat が最大)。崩れの検知として 130px を上限にする
        expect(header.height).toBeLessThanOrEqual(130);
        // ヘッダが画面幅からはみ出さない (body は overflow-hidden なので、はみ出しは切れて見えなくなる)
        expect(header.x + header.width).toBeLessThanOrEqual(width);
      });
    }
  }

  test("768px /deck: sm 以上は従来どおり 1 行 (見出しと操作群が同じ段)", async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 800 });
    await page.goto("/deck");
    const heading = (await page.getByRole("heading", { name: "デッキ構築・評価" }).boundingBox())!;
    const original = (await page.getByRole("button", { name: "Original" }).boundingBox())!;
    // 2 段なら操作群は見出しより下に来る
    expect(original.y).toBeLessThan(heading.y + heading.height);
    expect(original.x).toBeGreaterThan(heading.x + heading.width);
  });
});

test.describe("P-3 評価完了: lg 未満はサマリーストリップへ移動", () => {
  test("375px: ストリップにフォーカスが移り、上端付近までスクロールする", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await evaluate(page);
    const strip = page.getByTestId("eval-summary-strip");
    await expect(strip).toBeVisible({ timeout: 15000 });
    await expect(strip).toBeFocused();
    await expect(strip.getByText("C", { exact: true })).toBeVisible();
    // smooth スクロールの完了を待つ (所要時間はブラウザ依存)
    const headerBottom = (await page.locator("header").boundingBox())!;
    await expect
      .poll(async () => (await strip.boundingBox())!.y, { timeout: 5000 })
      .toBeLessThan(headerBottom.y + headerBottom.height + 40);
  });

  test("375px + reduced-motion: 瞬時に移動する", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 375, height: 812 });
    await evaluate(page);
    const strip = page.getByTestId("eval-summary-strip");
    await expect(strip).toBeFocused({ timeout: 15000 });
    const header = (await page.locator("header").boundingBox())!;
    // poll せず即座に測る (アニメーション無しで既に上端にいる)
    const y = (await strip.boundingBox())!.y;
    expect(y).toBeLessThan(header.y + header.height + 40);
  });

  test("375px: 評価に失敗したら結果へ移動しない (エラーを出すだけ)", async ({ page }) => {
    await page.route("**/api/deck/evaluate", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }),
    );
    await page.setViewportSize({ width: 375, height: 812 });
    await evaluate(page);
    await expect(page.getByText(/評価に失敗しました/)).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("eval-summary-strip")).toHaveCount(0);
  });

  test("1280px: ストリップは出さず、スクロールもフォーカス移動もしない (SR 通知のみ)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await evaluate(page);
    await expect(page.getByText("55/100")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("eval-summary-strip")).toBeHidden();
    await expect(page.getByTestId("eval-summary-strip")).not.toBeFocused();
    await expect(
      page.getByRole("status").filter({ hasText: "評価完了。ランクC、55点" }),
    ).toHaveCount(1);
    // 3 カラムのどれもスクロールしていない
    const scrolled = await page.evaluate(() =>
      Array.from(document.querySelectorAll("main, div")).some((el) => el.scrollTop > 0),
    );
    expect(scrolled).toBe(false);
  });
});
