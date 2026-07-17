import { test, expect } from "@playwright/test";

/**
 * デッキビルダーの「内容 ⇄ 画像」トグル (#129) が、狭い画面でも見えて押せること。
 *
 * ユーザー報告: 「スマホ版や全画面ではないときに表示されず押せなくなっています」。
 * lg 未満ではレイアウトが縦積みになるため、中央カラムのヘッダが潰れていないかを実測する。
 */
const VIEWPORTS = [
  { name: "スマホ", width: 375, height: 667 },
  { name: "スマホ大", width: 414, height: 896 },
  { name: "タブレット", width: 768, height: 1024 },
  { name: "非全画面PC (lg未満)", width: 1000, height: 800 },
  { name: "全画面PC", width: 1440, height: 900 },
];

for (const vp of VIEWPORTS) {
  test(`${vp.name} (${vp.width}px) で「画像」トグルが見えて押せる`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto("/deck");

    const imgTab = page.getByRole("button", { name: "画像" });
    await expect(imgTab).toBeVisible();
    // 押せる (他要素に覆われていない・幅0でない)
    await imgTab.click();
    // 押した結果、グリッド側の案内文が出る (未評価なのでプレースホルダ)
    await expect(
      page.getByText("デッキを評価・読込・自動構築するとカード画像が表示されます"),
    ).toBeVisible();
  });
}
