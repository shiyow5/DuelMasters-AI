import { test, expect } from "@playwright/test";

/**
 * 環境分析でデッキをクリックすると詳細が開く。
 *
 * E2E 環境には DB が無くティア表が空になるため、**API をモックして**実コンポーネントを検証する。
 */
const TIER_RESPONSE = {
  period_start: "2026-06-19",
  period_end: "2026-07-17",
  format: "original",
  tier_data: [
    {
      tier: "Tier1",
      archetype: "モルト系",
      usage_rate: 12.5,
      entries: 25,
      total_entries: 200,
      main_card: { name: "龍覇 グレンモルト", image_url: "https://example.test/molt.jpg" },
    },
  ],
};

const ARCHETYPE_RESPONSE = {
  archetype: "モルト系",
  format: "original",
  stats: { total_entries: 25, wins: 4, top4: 11, top8: 25 },
  recent_results: [
    {
      event_name: "テストCS",
      event_date: "2026-07-13",
      placement: 1,
      participants: 55,
      source_url: "https://example.test/entry",
      deck_archetype: "赤白モルト系",
    },
  ],
};

test.beforeEach(async ({ page }) => {
  await page.route("**/api/meta/tier**", (route) =>
    route.fulfill({ json: TIER_RESPONSE, headers: { "Access-Control-Allow-Origin": "*" } }),
  );
  await page.route("**/api/meta/archetype/**", (route) =>
    route.fulfill({ json: ARCHETYPE_RESPONSE, headers: { "Access-Control-Allow-Origin": "*" } }),
  );
  // カード画像は外部 CDN。E2E では取りに行かない。
  await page.route("https://example.test/**", (route) =>
    route.fulfill({ status: 200, contentType: "image/jpeg", body: "" }),
  );
});

test("デッキをクリックすると詳細が開き、戦績と出典が出る", async ({ page }) => {
  await page.goto("/meta");
  await page.getByRole("button", { name: "モルト系 の詳細を開く" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // 使用率・入賞数 (ティア表が持つ値)
  await expect(dialog.getByText("12.5%")).toBeVisible();
  // 戦績サマリ (archetype API 由来)。「優勝」はラベルと順位バッジの両方に出るので
  // 一意な "Top4" ラベルで確認する。
  await expect(dialog.getByText("Top4", { exact: true })).toBeVisible();
  await expect(dialog.getByText("テストCS")).toBeVisible();
  // 順位バッジ (recent_results の placement=1)
  await expect(dialog.getByRole("listitem").getByText("優勝")).toBeVisible();
  // 出典リンク
  await expect(dialog.locator('a[href="https://example.test/entry"]')).toBeVisible();
  // メインカード名
  await expect(dialog.getByText("龍覇 グレンモルト")).toBeVisible();
});

test("カード一覧が無いことを画面上で正直に伝える", async ({ page }) => {
  // 実デッキリストは DB に無い (#126 待ち)。黙って省かず、無い理由を書く。
  await page.goto("/meta");
  await page.getByRole("button", { name: "モルト系 の詳細を開く" }).click();
  await expect(
    page.getByRole("dialog").getByText(/デッキリストがまだありません|まだありません/),
  ).toBeVisible();
});

test("開くとフォーカスがモーダル内に移り、閉じるとトリガーに戻る", async ({ page }) => {
  // ネイティブ <dialog>.showModal() 由来の挙動。手作りオーバーレイでは背景に
  // 「見えないのにフォーカスが当たる」状態になっていた (レビュー指摘の HIGH)。
  await page.goto("/meta");
  const trigger = page.getByRole("button", { name: "モルト系 の詳細を開く" });
  await trigger.click();

  // フォーカスがダイアログの中にある
  await expect(page.getByRole("dialog")).toBeVisible();
  const focusInsideDialog = await page.evaluate(() => {
    const dlg = document.querySelector("dialog");
    return !!dlg && !!document.activeElement && dlg.contains(document.activeElement);
  });
  expect(focusInsideDialog).toBe(true);

  // 背景はモーダル中 inert。トリガーのカードはクリックできない (トップレイヤの外)。
  await expect(trigger).not.toBeFocused();

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  // 閉じたらトリガーへフォーカスが戻る
  await expect(trigger).toBeFocused();
});

test("閉じるボタンと Esc で閉じる", async ({ page }) => {
  await page.goto("/meta");
  await page.getByRole("button", { name: "モルト系 の詳細を開く" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();

  await page.getByRole("button", { name: "閉じる" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();

  await page.getByRole("button", { name: "モルト系 の詳細を開く" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
});
