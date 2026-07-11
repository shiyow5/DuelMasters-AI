import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getTestSql, hasTestDb, truncateAll } from "../../../tests/helpers/db.js";

describe.skipIf(!hasTestDb)("003 マイグレーション (統合)", () => {
  const sql = getTestSql()!;
  beforeEach(async () => truncateAll(sql));
  afterAll(async () => {
    await sql.end();
  });

  it("user_settings に INSERT/SELECT できる", async () => {
    await sql`INSERT INTO user_settings (user_id, format) VALUES ('discord:1', 'advance')`;
    const rows = await sql`SELECT format FROM user_settings WHERE user_id = 'discord:1'`;
    expect(rows[0].format).toBe("advance");
  });

  it("tournament_results の同一行2回目は unique violation", async () => {
    const insert = () =>
      sql`INSERT INTO tournament_results (event_name, event_date, format, deck_archetype, placement)
          VALUES ('CS', '2026-07-01', 'original', 'アグロ', 1)`;
    await insert();
    await expect(insert()).rejects.toThrow();
  });
});
