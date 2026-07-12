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
