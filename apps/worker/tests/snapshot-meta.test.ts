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
});
