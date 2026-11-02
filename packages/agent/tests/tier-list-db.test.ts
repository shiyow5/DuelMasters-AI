import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { getTestSql, hasTestDb, truncateAll, enableAppDb } from "../../../tests/helpers/db.js";

const { runTool } = await import("../src/tools.js");

const today = new Date().toISOString().split("T")[0];

/** tools.ts と同じ計算 (ローカル日付で n 日戻して ISO 日付にする) */
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split("T")[0];
}

async function archetypesOf(period: string): Promise<string[]> {
  const res = await runTool("get_tier_list", { format: "original", period });
  expect(res.ok ?? true).toBe(true);
  const data = JSON.parse(res.text) as Array<{ archetype: string }>;
  return data.map((t) => t.archetype).sort();
}

describe.skipIf(!hasTestDb)("get_tier_list (統合)", () => {
  const sql = getTestSql()!;
  beforeAll(() => enableAppDb());
  afterAll(async () => {
    await sql.end();
  });
  beforeEach(async () => {
    await truncateAll(sql);
  });

  it("期間 (2w/4w/8w) ごとに別の集計を返す (同じ長さのスナップショットだけを使う)", async () => {
    // cron が作るのは 4 週ぶんのスナップショットだけ。長さを見ずに最新を返すと、
    // 2w / 8w でもこの 4 週ぶんが返ってしまう (QA③ と同じバグ)。
    await sql`INSERT INTO meta_snapshots (format, period_start, period_end, tier_data)
      VALUES ('original', ${daysAgo(28)}, ${today},
              ${sql.json([{ archetype: "スナップ4週", usage_rate: 100, count: 1, tier: "S" }])})`;
    // 週次ランキング: 直近 2 週・2〜4 週前・4〜8 週前に 1 件ずつ
    await sql`INSERT INTO archetype_weekly_stats
      (format, period_start, period_end, deck_archetype, entries, total_entries)
      VALUES ('original', ${daysAgo(9)}, ${daysAgo(3)}, '直近', 10, 10),
             ('original', ${daysAgo(26)}, ${daysAgo(20)}, '中間', 10, 10),
             ('original', ${daysAgo(51)}, ${daysAgo(45)}, '古い', 10, 10)`;

    // 4w は同じ長さのスナップショットがあるのでそれを使う
    expect(await archetypesOf("4w")).toEqual(["スナップ4週"]);
    // 2w / 8w は同じ長さのスナップショットが無いので、その場集計に落ちる
    expect(await archetypesOf("2w")).toEqual(["直近"]);
    expect(await archetypesOf("8w")).toEqual(["中間", "古い", "直近"].sort());
  });

  it("同じ長さのスナップショットがあれば、その期間でも使う (8w)", async () => {
    await sql`INSERT INTO meta_snapshots (format, period_start, period_end, tier_data)
      VALUES ('original', ${daysAgo(28)}, ${today},
              ${sql.json([{ archetype: "スナップ4週", usage_rate: 100, count: 1, tier: "S" }])}),
             ('original', ${daysAgo(56)}, ${today},
              ${sql.json([{ archetype: "スナップ8週", usage_rate: 100, count: 1, tier: "S" }])})`;

    expect(await archetypesOf("8w")).toEqual(["スナップ8週"]);
  });

  it("データが無ければ「ティアデータがまだありません」を返す", async () => {
    const res = await runTool("get_tier_list", { format: "original", period: "2w" });
    expect(res.text).toBe("ティアデータがまだありません");
  });
});
