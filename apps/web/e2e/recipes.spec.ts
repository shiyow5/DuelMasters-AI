import { test, expect } from "@playwright/test";

/**
 * CS入賞デッキレシピ一覧 (#126)。
 *
 * E2E 環境には DB が無く一覧が空になるため、**API をモックして**実コンポーネントを検証する。
 */
const RECIPE = {
  source_url: "https://deneblog.jp/blog-entry-22941.html",
  posted_date: "2026-07-13",
  event_name: "トレカラインCS",
  placement_label: "優勝",
  deck_name: "サガループ",
  player: "mofura",
  participants: 55,
  decklist_image_url: "https://blog-imgs-201.fc2.test/deck.jpg",
};

const LIST = { recipes: [RECIPE], total: 1, limit: 24, offset: 0 };

test.beforeEach(async ({ page }) => {
  await page.route("**/api/recipes**", (route) =>
    route.fulfill({ json: LIST, headers: { "Access-Control-Allow-Origin": "*" } }),
  );
  // レシピ画像は外部 CDN (fc2)。E2E では取りに行かない。
  await page.route("https://blog-imgs-201.fc2.test/**", (route) =>
    route.fulfill({ status: 200, contentType: "image/jpeg", body: "" }),
  );
});

test("レシピ一覧に大会名・順位・デッキ名・出典が出る", async ({ page }) => {
  await page.goto("/recipes");
  await expect(page.getByRole("heading", { name: "CS入賞デッキレシピ" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "サガループ" })).toBeVisible();
  await expect(page.getByText("トレカラインCS")).toBeVisible();
  await expect(page.getByText("優勝", { exact: true })).toBeVisible();
  await expect(page.getByText("2026-07-13 掲載")).toBeVisible();
  await expect(page.getByText(/55人参加/)).toBeVisible();
  await expect(page.locator(`a[href="${RECIPE.source_url}"]`)).toBeVisible();
});

test("フォーマットで絞れない理由を画面上で正直に伝える", async ({ page }) => {
  // 取込元がフォーマットを書いていないという制約を黙って隠さない (#122 と同じ思想)。
  await page.goto("/recipes");
  await expect(page.getByText(/フォーマット .* 記載していない|絞り込めません/)).toBeVisible();
});

test("画像をクリックすると拡大され、Esc で閉じてフォーカスが戻る", async ({ page }) => {
  await page.goto("/recipes");
  const trigger = page.getByRole("button", { name: "サガループ のデッキリストを拡大" });
  await trigger.click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // ネイティブ <dialog>.showModal() 由来: フォーカスがモーダル内に入る
  const inside = await page.evaluate(() => {
    const d = document.querySelector("dialog");
    return !!d && !!document.activeElement && d.contains(document.activeElement);
  });
  expect(inside).toBe(true);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("拡大モーダルが画面中央に出る (左上に張り付かない)", async ({ page }) => {
  // Tailwind preflight の `*,::backdrop{margin:0}` が UA の `dialog:modal{margin:auto}` を
  // 潰す回帰を座標で固定する (#144 で実際に踏んだ)。
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/recipes");
  await page.getByRole("button", { name: "サガループ のデッキリストを拡大" }).click();

  const box = await page.getByRole("dialog").boundingBox();
  expect(box).not.toBeNull();
  expect(Math.abs(box!.x + box!.width / 2 - 640)).toBeLessThanOrEqual(2);
  expect(box!.x).toBeGreaterThan(0);
});

test("検索語を API に q として渡す", async ({ page }) => {
  const urls: string[] = [];
  await page.route("**/api/recipes**", (route) => {
    urls.push(route.request().url());
    return route.fulfill({ json: LIST, headers: { "Access-Control-Allow-Origin": "*" } });
  });

  await page.goto("/recipes");
  await page.getByRole("searchbox", { name: "デッキ名・大会名で検索" }).fill("ウィリデ");
  await page.getByRole("button", { name: "検索" }).click();

  await expect
    .poll(() => urls.some((u) => u.includes("q=") && u.includes(encodeURIComponent("ウィリデ"))))
    .toBe(true);
});

test("一致が無いときは空表示にする (エラーにしない)", async ({ page }) => {
  await page.route("**/api/recipes**", (route) =>
    route.fulfill({
      json: { recipes: [], total: 0, limit: 24, offset: 0 },
      headers: { "Access-Control-Allow-Origin": "*" },
    }),
  );
  await page.goto("/recipes");
  await expect(page.getByText(/まだありません|一致するレシピはありません/)).toBeVisible();
});
