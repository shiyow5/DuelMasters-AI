import { describe, it, expect, vi } from "vitest";

// regulations が0件 / 規制あり の DB 応答を差し替える (#164)
const rows: { card_name: string; restriction_type: string }[] = [];
vi.mock("@dm-ai/db", () => ({
  getSql: () => async () => rows,
}));

import { parseDecklist } from "../src/parser.js";
import { validateRegulation } from "../src/validator.js";

const deck40 = parseDecklist(Array.from({ length: 10 }, (_, i) => `4 カード${i + 1}`).join("\n"));

describe("validateRegulation 殿堂チェックの実施有無 (#164)", () => {
  it("regulations が0件なら未確認 (restrictionChecked=false) + 警告", async () => {
    rows.length = 0;
    const res = await validateRegulation(deck40, "advance");
    expect(res.valid).toBe(true);
    expect(res.restrictionChecked).toBe(false);
    expect(res.warnings.some((w) => w.includes("殿堂チェックができませんでした"))).toBe(true);
  });

  it("regulations があれば実施済み (restrictionChecked=true)", async () => {
    rows.length = 0;
    rows.push({ card_name: "別のカード", restriction_type: "hall_of_fame" });
    const res = await validateRegulation(deck40, "advance");
    expect(res.restrictionChecked).toBe(true);
  });

  it("未確認でも枚数エラーは落とさない", async () => {
    rows.length = 0;
    const res = await validateRegulation(parseDecklist("4 カードA"), "advance");
    expect(res.valid).toBe(false);
    expect(res.restrictionChecked).toBe(false);
  });
});
