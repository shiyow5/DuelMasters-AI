import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { getTestSql, hasTestDb, enableAppDb, truncateAll } from "../../../tests/helpers/db.js";
import { runTool } from "../src/tools.js";

describe("runTool search_cards バリデーション (単体)", () => {
  it("不正な civilization は throw せずエラーメッセージを返す", async () => {
    const result = await runTool("search_cards", {
      query: "x",
      civilization: "purple",
    });
    expect(result.text).toContain("ツール引数が不正です");
  });
});

describe.skipIf(!hasTestDb)("runTool search_cards フィルタ (統合)", () => {
  const sql = getTestSql()!;
  beforeAll(() => enableAppDb());
  beforeEach(async () => {
    await truncateAll(sql);
    await sql`INSERT INTO cards (name, civilizations, cost, type, text) VALUES
      ('火の1', '["fire"]', 2, 'creature', 'ドラゴン'),
      ('水の1', '["water"]', 8, 'spell', 'ドラゴン')`;
  });
  afterAll(async () => {
    await sql.end();
  });

  it("civilization フィルタが効く", async () => {
    const r = await runTool("search_cards", { query: "ドラゴン", civilization: "fire" });
    expect(r.text).toContain("火の1");
    expect(r.text).not.toContain("水の1");
  });

  it("max_cost フィルタが効く", async () => {
    const r = await runTool("search_cards", { query: "ドラゴン", max_cost: 5 });
    expect(r.text).toContain("火の1");
    expect(r.text).not.toContain("水の1");
  });

  it("type フィルタが効く", async () => {
    const r = await runTool("search_cards", { query: "ドラゴン", type: "spell" });
    expect(r.text).toContain("水の1");
    expect(r.text).not.toContain("火の1");
  });
});

describe.skipIf(!hasTestDb)("runTool build_deck 文明制約 (統合)", () => {
  const sql = getTestSql()!;
  beforeAll(() => enableAppDb());
  beforeEach(async () => {
    await truncateAll(sql);
    // 火 8 種 (最大 32 枚 < DECK_SIZE) + 水 1 枚。文明未指定なら 40 枚に届かず水もフィラーに
    // 使われ、civ=fire なら水を除外する — の両方を安定して検証できる枚数。
    for (let i = 0; i < 8; i++) {
      await sql`INSERT INTO cards (name, civilizations, cost, type, text) VALUES
        (${"火クリーチャー" + i}, '["fire"]', ${1 + (i % 4)}, 'creature', '速攻アタッカー')`;
    }
    await sql`INSERT INTO cards (name, civilizations, cost, type, text) VALUES
      ('水クリーチャー', '["water"]', 3, 'creature', '速攻アタッカー')`;
  });
  afterAll(async () => {
    await sql.end();
  });

  it("civilizations=fire を渡すと水文明カードを含めない", async () => {
    const r = await runTool(
      "build_deck",
      { theme: "速攻", civilizations: ["fire"], max_cost: 5 },
      "advance",
    );
    expect(r.text).toContain("火クリーチャー");
    expect(r.text).not.toContain("水クリーチャー");
  });

  it("文明未指定なら水文明も候補に入り得る (制約なしの既定動作)", async () => {
    // 火のみだと 40 枚に満たないため水もフィラーに使われる = 文明制約が既定で無いことの確認。
    const r = await runTool("build_deck", { theme: "速攻" }, "advance");
    expect(r.text).toContain("水クリーチャー");
  });
});
