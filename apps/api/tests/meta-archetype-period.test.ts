import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { Hono } from "hono";
import { getTestSql, hasTestDb, enableAppDb, truncateAll } from "../../../tests/helpers/db.js";
import { metaRouter } from "../src/routes/meta.js";

function makeApp() {
  const app = new Hono();
  app.route("/api/meta", metaRouter);
  return app;
}

/** n 日前の YYYY-MM-DD。 */
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split("T")[0];
}

/**
 * GET /api/meta/archetype/:name の期間フィルタ。
 *
 * ティアカードの使用率・入賞数は `/tier?period=2w|4w|8w` で期間を絞った値。詳細だけ全期間を
 * 返すと、開いたカードと数字が矛盾する (2週間で数件のデッキを開いて「記録数」が跳ね上がる)。
 */
describe.skipIf(!hasTestDb)("GET /api/meta/archetype/:name の期間フィルタ (統合)", () => {
  const sql = getTestSql()!;
  beforeAll(() => enableAppDb());
  afterAll(async () => {
    await sql.end();
  });

  const result = (date: string, placement: number) =>
    sql`INSERT INTO tournament_results (event_name, event_date, format, deck_archetype, placement)
        VALUES (${"CS " + date}, ${date}, 'original', 'モルト系', ${placement})`;

  // 窓は weeks*7 日。2w=14日 / 4w=28日 / 8w=56日 なので、境界に近すぎない日付を選ぶ。
  beforeEach(async () => {
    await truncateAll(sql);
    await result(daysAgo(3), 1); // 2w(14日)の内
    await result(daysAgo(20), 1); // 2w の外、4w(28日)の内
    await result(daysAgo(50), 1); // 4w の外、8w(56日)の内
  });

  it("period=2w なら直近2週間の記録だけを数える", async () => {
    const res = await makeApp().request("/api/meta/archetype/モルト系?format=original&period=2w");
    const body = (await res.json()) as {
      stats: { total_entries: number; wins: number };
      recent_results: unknown[];
    };
    expect(body.stats.total_entries).toBe(1);
    expect(body.stats.wins).toBe(1);
    expect(body.recent_results).toHaveLength(1);
  });

  it("period=4w なら4週間分を数える", async () => {
    const res = await makeApp().request("/api/meta/archetype/モルト系?format=original&period=4w");
    const body = (await res.json()) as { stats: { total_entries: number } };
    expect(body.stats.total_entries).toBe(2);
  });

  it("period=8w なら8週間分を数える (期間を広げれば増える)", async () => {
    const res = await makeApp().request("/api/meta/archetype/モルト系?format=original&period=8w");
    const body = (await res.json()) as { stats: { total_entries: number } };
    expect(body.stats.total_entries).toBe(3);
  });

  it("period 未指定は 4w 扱い (ティア表の既定と揃える)", async () => {
    const res = await makeApp().request("/api/meta/archetype/モルト系?format=original");
    const body = (await res.json()) as { stats: { total_entries: number }; period: string };
    expect(body.period).toBe("4w");
    expect(body.stats.total_entries).toBe(2);
  });
});
