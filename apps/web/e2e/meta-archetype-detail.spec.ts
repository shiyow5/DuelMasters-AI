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

test("詳細リクエストにティア表と同じ period を渡す", async ({ page }) => {
  // カードの使用率・入賞数は period で絞った値。詳細だけ全期間になると数字が矛盾する
  // (2週間で5件のデッキを開いて「記録数25」になる)。Codex 指摘の回帰ガード。
  const urls: string[] = [];
  await page.route("**/api/meta/archetype/**", (route) => {
    urls.push(route.request().url());
    return route.fulfill({
      json: ARCHETYPE_RESPONSE,
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  });

  await page.goto("/meta");
  // 期間を 2週間 に変えてから開く
  await page.getByRole("button", { name: "過去2週間" }).click();
  await page.getByRole("button", { name: "モルト系 の詳細を開く" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();

  expect(urls.length).toBeGreaterThan(0);
  expect(urls[urls.length - 1]).toContain("period=2w");
});

test("モーダルが画面中央に出る (左上に張り付かない)", async ({ page }) => {
  // Tailwind v4 の preflight は `*, ::backdrop { margin:0 }` を当てるため、UA スタイルの
  // `dialog:modal { margin:auto }` が潰れて左上に張り付く。m-auto で戻している。
  // 可視性・クリック可否のテストだけでは**位置の崩れを見逃す**ので、座標で固定する。
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/meta");
  await page.getByRole("button", { name: "モルト系 の詳細を開く" }).click();

  const box = await page.getByRole("dialog").boundingBox();
  expect(box).not.toBeNull();
  const centerX = box!.x + box!.width / 2;
  // 水平方向がビューポート中央 (誤差 2px)
  expect(Math.abs(centerX - 640)).toBeLessThanOrEqual(2);
  // 左上に張り付いていない
  expect(box!.x).toBeGreaterThan(0);
  expect(box!.y).toBeGreaterThan(0);
});

test("背景 (::backdrop) のクリックで閉じる", async ({ page }) => {
  await page.goto("/meta");
  await page.getByRole("button", { name: "モルト系 の詳細を開く" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();

  // dialog の箱の外 = ::backdrop。左上隅を押す。
  await page.mouse.click(5, 5);
  await expect(page.getByRole("dialog")).toBeHidden();
});

test("モーダル内から始まったドラッグでは閉じない (テキスト選択を壊さない)", async ({ page }) => {
  // click は mousedown/mouseup で要素が違うと共通の祖先で発火する。押した位置を見ないと
  // 「中で選択を始めて外で離した」だけで閉じてしまう。
  await page.goto("/meta");
  await page.getByRole("button", { name: "モルト系 の詳細を開く" }).click();
  const dialog = page.getByRole("dialog");
  const box = (await dialog.boundingBox())!;

  await page.mouse.move(box.x + box.width / 2, box.y + 40);
  await page.mouse.down(); // モーダルの中で押す
  await page.mouse.move(5, 5); // 背景まで引っ張って
  await page.mouse.up(); // 外で離す
  await expect(dialog).toBeVisible(); // 閉じない
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
