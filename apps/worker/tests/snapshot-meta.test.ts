import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { getTestSql, hasTestDb, enableAppDb, truncateAll } from "../../../tests/helpers/db.js";

describe.skipIf(!hasTestDb)("snapshot:meta (統合)", () => {
  const sql = getTestSql()!;
  beforeAll(() => enableAppDb());
  beforeEach(async () => truncateAll(sql));
  afterAll(async () => {
    await sql.end();
  });

  it("集計してスナップショットを1行 UPSERT する (再実行で増えない)", async () => {
    const today = new Date().toISOString().split("T")[0];
    for (let i = 0; i < 7; i++) {
      await sql`INSERT INTO tournament_results (event_name, event_date, format, deck_archetype, placement)
        VALUES ('CS', ${today}, 'original', 'アグロ', ${i + 1})`;
    }
    for (let i = 0; i < 3; i++) {
      await sql`INSERT INTO tournament_results (event_name, event_date, format, deck_archetype, placement)
        VALUES ('CS2', ${today}, 'original', 'コントロール', ${i + 1})`;
    }

    const { runSnapshotMeta } = await import("../src/jobs/snapshot-meta.js");
    const r = await runSnapshotMeta("original", 4);
    expect(r.created).toBe(true);
    expect(r.archetypes).toBe(2);

    const snaps = await sql`SELECT tier_data FROM meta_snapshots WHERE format = 'original'`;
    expect(snaps.length).toBe(1);

    await runSnapshotMeta("original", 4);
    const count = await sql`SELECT count(*)::int as n FROM meta_snapshots`;
    expect(count[0].n).toBe(1);
  });

  it("週次ランキングがあればそちらを使う (個別 CS 記事は母集団の一部でしかない)", async () => {
    const today = new Date().toISOString().split("T")[0];
    // 個別 CS 記事由来: アグロ 1件だけ (偏った標本)
    await sql`INSERT INTO tournament_results (event_name, event_date, format, deck_archetype, placement)
      VALUES ('CS', ${today}, 'original', 'アグロ', 1)`;
    // 週次ランキング由来: 母数 100 の全量
    await sql`INSERT INTO archetype_weekly_stats
      (format, period_start, period_end, deck_archetype, entries, total_entries)
      VALUES ('original', ${today}, ${today}, 'ウィリデ', 60, 100),
             ('original', ${today}, ${today}, 'ダーバンデ', 40, 100)`;

    const { runSnapshotMeta } = await import("../src/jobs/snapshot-meta.js");
    const r = await runSnapshotMeta("original", 4);
    expect(r.source).toBe("weekly");

    const snaps = await sql`SELECT tier_data FROM meta_snapshots WHERE format = 'original'`;
    const tiers = snaps[0].tier_data as Array<{ archetype: string; usage_rate: number }>;
    expect(tiers.map((t) => t.archetype)).toEqual(["ウィリデ", "ダーバンデ"]);
    expect(tiers[0].usage_rate).toBe(60);
    // 個別 CS 記事の「アグロ」は母集団に混ぜない
    expect(tiers.map((t) => t.archetype)).not.toContain("アグロ");
  });

  it("複数週の入賞数を合算する", async () => {
    const iso = (daysAgo: number) =>
      new Date(Date.now() - daysAgo * 86400000).toISOString().split("T")[0];
    await sql`INSERT INTO archetype_weekly_stats
      (format, period_start, period_end, deck_archetype, entries, total_entries)
      VALUES ('original', ${iso(13)}, ${iso(7)}, 'ウィリデ', 10, 20),
             ('original', ${iso(13)}, ${iso(7)}, 'ダーバンデ', 10, 20),
             ('original', ${iso(6)},  ${iso(0)}, 'ウィリデ', 30, 40),
             ('original', ${iso(6)},  ${iso(0)}, 'ダーバンデ', 10, 40)`;

    const { runSnapshotMeta } = await import("../src/jobs/snapshot-meta.js");
    await runSnapshotMeta("original", 4);

    const snaps = await sql`SELECT tier_data FROM meta_snapshots WHERE format = 'original'`;
    const tiers = snaps[0].tier_data as Array<{ archetype: string; usage_rate: number }>;
    // ウィリデ 40 / ダーバンデ 20 → 66.7% / 33.3%
    expect(tiers[0]).toMatchObject({ archetype: "ウィリデ", usage_rate: 66.7 });
    expect(tiers[1]).toMatchObject({ archetype: "ダーバンデ", usage_rate: 33.3 });
  });
});
